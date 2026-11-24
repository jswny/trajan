import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { TurnTranscript } from "@trajan/effect-harness";
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
	if (receipt.runId === null) throw new Error(receipt.error);
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
		if (executionId === undefined) throw new Error("Expected the tool execution ID");
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
