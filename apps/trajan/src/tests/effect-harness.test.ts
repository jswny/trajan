import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ToolResult, TurnMessage, TurnTranscript } from "@trajan/effect-harness";
import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

const submission = { id: "submission-1", prompt: "hello" };
const prompt = { role: "user", text: submission.prompt };
const toolCall = {
	role: "tool-call",
	id: "append-1",
	name: "append",
	input: { text: submission.prompt },
};
const completedTool = { status: "completed", output: "hello" };
const unknownTool = { status: "unknown", message: "The previous tool outcome is unknown." };

function openFixture() {
	return env.EFFECT_HARNESS_TEST.getByName(crypto.randomUUID());
}

async function submit(stub: ReturnType<typeof openFixture>, input = submission) {
	const receipt = await stub.submit(input);
	if (receipt.runId === null) {
		throw new Error(receipt.error);
	}
	return receipt;
}

async function readTurn(stub: ReturnType<typeof openFixture>, runId: string) {
	const { transcript, ...run } = await stub.turn(runId);
	return {
		...run,
		result:
			transcript === null
				? null
				: Schema.decodeSync(Schema.fromJsonString(TurnTranscript))(transcript),
	};
}

test("deduplicates a submission and retains one complete transcript", async () => {
	const stub = openFixture();
	const receipts = await Promise.all([submit(stub), submit(stub)]);
	const [receipt] = receipts;
	expect(receipts.filter((candidate) => candidate.accepted)).toHaveLength(1);
	expect(receipts[1].runId).toBe(receipt.runId);
	await expect
		.poll(() => readTurn(stub, receipt.runId))
		.toMatchObject({
			state: "completed",
			result: {
				submissionId: submission.id,
				messages: [
					prompt,
					toolCall,
					{ role: "tool", callId: toolCall.id, result: completedTool },
					{ role: "assistant", text: 'Wrote "hello"' },
				],
			},
		});
	expect(await stub.state()).toMatchObject({ text: "hello" });
});

test("validates a submission before it can start a task", async () => {
	const stub = openFixture();
	expect(await stub.submit({ id: "", prompt: "hello" })).toMatchObject({
		accepted: false,
		runId: null,
		error: expect.stringContaining('["id"]'),
	});
	expect(await stub.state()).toMatchObject({ text: "" });
});

test("Effect workspace tools validate file calls and preserve unsafe recovery", async () => {
	const stub = openFixture();
	const path = "/workspace/notes.txt";
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	expect(decode(await stub.workspaceTool("write", { path, content: "milk" }))).toMatchObject({
		status: "completed",
	});
	expect(decode(await stub.workspaceTool("read", { path }, true))).toMatchObject({
		status: "completed",
		output: expect.arrayContaining([{ type: "text", text: expect.stringContaining("milk") }]),
	});
	expect(decode(await stub.workspaceTool("write", { path }))).toMatchObject({ status: "failed" });
	expect(decode(await stub.workspaceTool("codemode", { code: "return 1" }, true))).toMatchObject({
		status: "unknown",
	});
	expect(decode(await stub.workspaceTool("exec", { command: "return 1" }))).toMatchObject({
		status: "failed",
	});
});

test("returns invalid tool arguments to the model without writing to the workspace", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub, { id: "bad-append", prompt: "Call append without text." });
	const message = "Invalid append arguments. Provide a non-empty text string.";
	await expect
		.poll(() => readTurn(stub, runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: "Call append without text." },
					{ role: "tool-call", name: "append", input: { text: "" } },
					{ role: "tool", callId: "append-1", result: { status: "failed", message } },
					{ role: "assistant", text: message },
				],
			},
		});
	expect(await stub.state()).toMatchObject({ text: "" });
});

test.each([
	{
		name: "reattaches to the completed tool after a restart before its checkpoint",
		discardExecution: false,
		toolResult: completedTool,
		reply: 'Wrote "hello"',
	},
	{
		name: "reports an unknown outcome when the interrupted tool record is gone",
		discardExecution: true,
		toolResult: unknownTool,
		reply: unknownTool.message,
	},
])("$name", async ({ discardExecution, toolResult, reply }) => {
	let stub = openFixture();
	await stub.pause("after-write");
	const { runId } = await submit(stub);
	await expect
		.poll(() => stub.state(), { timeout: 5000 })
		.toMatchObject({
			text: "hello",
			executionId: expect.any(String),
		});
	const { executionId, instance } = await stub.state();
	expect(await stub.turn(runId)).toMatchObject({ state: "running" });
	if (discardExecution) {
		if (executionId === undefined) {
			throw new Error("Expected the tool execution ID");
		}
		await stub.discardExecution(executionId);
	}

	await expect(stub.crash()).rejects.toThrow(/forced Effect harness fixture restart|reset/i);
	stub = env.EFFECT_HARNESS_TEST.get(stub.id);
	expect((await stub.state()).instance).not.toBe(instance);
	await stub.release();
	await runDurableObjectAlarm(stub);

	await expect
		.poll(() => readTurn(stub, runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				submissionId: submission.id,
				messages: [
					prompt,
					toolCall,
					{ role: "tool", callId: toolCall.id, result: toolResult },
					{ role: "assistant", text: reply },
				],
			},
		});
	expect(await stub.submit(submission)).toMatchObject({ runId, accepted: false });
	expect(await stub.state()).toMatchObject({ text: "hello" });
});

test("a restart between tool calls reuses the first result and still executes the second call", async () => {
	const input = { id: "multi-tool", prompt: "Append hello, then world." };
	let stub = openFixture();
	await stub.pause("between-tools");
	const { runId } = await submit(stub, input);
	await expect
		.poll(() => stub.state(), { timeout: 5000 })
		.toMatchObject({
			pausedAt: "between-tools",
			text: "hello",
		});
	const { instance } = await stub.state();
	expect(await stub.turn(runId)).toMatchObject({ state: "running" });

	await expect(stub.crash()).rejects.toThrow(/forced Effect harness fixture restart|reset/i);
	stub = env.EFFECT_HARNESS_TEST.get(stub.id);
	expect((await stub.state()).instance).not.toBe(instance);
	await stub.release();
	await runDurableObjectAlarm(stub);

	await expect
		.poll(() => readTurn(stub, runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				submissionId: input.id,
				messages: [
					{ role: "user", text: input.prompt },
					toolCall,
					{ role: "tool", callId: toolCall.id, result: completedTool },
					{ role: "tool-call", id: "append-2", name: "append", input: { text: " world" } },
					{
						role: "tool",
						callId: "append-2",
						result: { status: "completed", output: "hello world" },
					},
					{ role: "assistant", text: 'Wrote "hello world"' },
				],
			},
		});
	expect(await stub.submit(input)).toMatchObject({ runId, accepted: false });
	expect(await stub.state()).toMatchObject({ text: "hello world" });
});

const remember = (phrase: string) => ({ id: "remember", prompt: `Remember ${phrase}` });
const recall = { id: "recall", prompt: "What did I ask you to remember?" };
const messageJson = Schema.fromJsonString(TurnMessage);

test("recovers the inbox if the object restarts before starting the accepted task", async () => {
	const phrase = crypto.randomUUID();
	let stub = openFixture();
	await stub.pause("before-task");
	const first = await submit(stub, remember(phrase));
	await expect
		.poll(() => stub.state(), { timeout: 5000 })
		.toMatchObject({ pausedAt: "before-task" });
	const second = await submit(stub, recall);
	expect(await stub.taskState(first.runId)).toBe("missing");
	expect(await stub.taskState(second.runId)).toBe("missing");

	await expect(stub.crash()).rejects.toThrow(/forced Effect harness fixture restart|reset/i);
	stub = env.EFFECT_HARNESS_TEST.get(stub.id);
	await stub.release();
	await runDurableObjectAlarm(stub);

	await expect
		.poll(() => readTurn(stub, second.runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				submissionId: recall.id,
				messages: [
					{ role: "user", text: recall.prompt },
					{ role: "assistant", text: phrase },
				],
			},
		});
	expect(await stub.submit(remember(phrase))).toMatchObject({
		accepted: false,
		runId: first.runId,
	});
});

test("a turn committed before the task settles appears once in history and in the next turn's context", async () => {
	const phrase = crypto.randomUUID();
	const input = remember(phrase);
	let stub = openFixture();
	await stub.pause("after-commit");
	const first = await submit(stub, input);
	await expect
		.poll(() => stub.state(), { timeout: 5000 })
		.toMatchObject({ pausedAt: "after-commit" });
	expect(await stub.turn(first.runId)).toMatchObject({ state: "completed" });
	expect(await stub.taskState(first.runId)).toBe("running");

	await expect(stub.crash()).rejects.toThrow(/forced Effect harness fixture restart|reset/i);
	stub = env.EFFECT_HARNESS_TEST.get(stub.id);
	await stub.release();
	await runDurableObjectAlarm(stub);

	const second = await submit(stub, recall);
	await expect
		.poll(() => readTurn(stub, second.runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: recall.prompt },
					{ role: "assistant", text: phrase },
				],
			},
		});
	expect(await stub.submit(recall)).toMatchObject({ accepted: false, runId: second.runId });

	const newest = await stub.history({ limit: 2 });
	if (newest.nextBefore === null) {
		throw new Error("Expected an earlier history page");
	}
	const older = await stub.history({ before: newest.nextBefore, limit: 2 });
	expect(older.nextBefore).toBeNull();
	expect(
		[...older.entries, ...newest.entries].map(({ id, submissionId, message }) => ({
			id,
			submissionId,
			...Schema.decodeSync(messageJson)(message),
		})),
	).toEqual([
		{ id: 1, submissionId: input.id, role: "user", text: input.prompt },
		{ id: 2, submissionId: input.id, role: "assistant", text: `Remembering ${phrase}` },
		{ id: 3, submissionId: recall.id, role: "user", text: recall.prompt },
		{ id: 4, submissionId: recall.id, role: "assistant", text: phrase },
	]);
	await expect.poll(() => stub.taskState(first.runId), { timeout: 5000 }).toBe("completed");
});

test("keeps a large exchange in history when it falls outside the model's context budget", async () => {
	const stub = openFixture();
	const input = remember("a".repeat(16_000));
	const first = await submit(stub, input);
	await expect
		.poll(() => stub.turn(first.runId), { timeout: 5000 })
		.toMatchObject({ state: "completed" });
	const second = await submit(stub, recall);
	await expect
		.poll(() => readTurn(stub, second.runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: recall.prompt },
					{ role: "assistant", text: "I don't know." },
				],
			},
		});
	const { entries } = await stub.history({});
	expect(entries).toHaveLength(4);
	expect(Schema.decodeSync(messageJson)(entries[0].message)).toEqual({
		role: "user",
		text: input.prompt,
	});
});

test("settles a failed model turn and proceeds to the next queued submission", async () => {
	let stub = openFixture();
	const first = await submit(stub, { id: "fail", prompt: "Fail this turn." });
	const second = await submit(stub, remember("a later submission"));

	await expect
		.poll(() => stub.turn(first.runId), { timeout: 5000 })
		.toMatchObject({
			state: "failed",
			error: "The fixture model failed.",
			failure: { code: "model", message: "The fixture model failed." },
			transcript: null,
		});
	await expect
		.poll(() => stub.turn(second.runId), { timeout: 5000 })
		.toMatchObject({ state: "completed" });
	await expect(stub.crash()).rejects.toThrow(/forced Effect harness fixture restart|reset/i);
	stub = env.EFFECT_HARNESS_TEST.get(stub.id);
	expect(await stub.turn(first.runId)).toMatchObject({
		state: "failed",
		failure: { code: "model", message: "The fixture model failed." },
	});
	expect(await stub.history({})).toMatchObject({
		entries: [{ submissionId: "remember" }, { submissionId: "remember" }],
	});
});
