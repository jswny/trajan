import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ToolResult, TurnMessage, TurnTranscript, toolPreviewBytes } from "@trajan/harness";
import { Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { ChatEvent, ChatPath } from "../chat/protocol";
import { readToolActivity, toolActivity } from "../chat/tool-activity";
import { nextWeeklyRun } from "../turn-schedules";
import { appendExecInput } from "./chat-runtime-fixture";
import {
	compactReference,
	compactResumePrompt,
	compactSetupPrompt,
} from "./openai-responses-fixture";

const submission = { id: "submission-1", prompt: "hello" };
const prompt = { role: "user", text: submission.prompt };
const toolCall = {
	role: "tool-call",
	id: "append-1",
	name: "exec",
	input: appendExecInput(submission.prompt),
};
const completedTool = { status: "completed", output: "hello" };
const unknownMessage = expect.stringContaining("Inspect it before repeating the action.");
const unknownTool = { status: "unknown", message: unknownMessage };

test("bounds tool previews without splitting multibyte text and summarizes image data", () => {
	const input = `a${"📝".repeat(toolPreviewBytes)}`;
	const preview = toolActivity({
		id: "capture",
		name: "capture",
		input,
		status: "completed",
		reply: {
			status: "returned",
			value: [{ type: "image", mimeType: "image/jpeg", data: "private-image-payload" }],
		},
	});
	expect(preview.input).toEqual({
		format: "text",
		truncated: true,
		text: `a${"📝".repeat(Math.floor((toolPreviewBytes - 1) / 4))}`,
	});
	expect(preview.output).toEqual({ format: "text", truncated: false, text: "Image (image/jpeg)" });
});

function openFixture() {
	return env.CHAT_TEST.getByName(crypto.randomUUID());
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

test("rejects reuse of a submission ID with a different prompt", async () => {
	const stub = openFixture();
	await submit(stub);
	expect(await stub.submit({ ...submission, prompt: "a different prompt" })).toMatchObject({
		runId: null,
		accepted: false,
		error: expect.stringContaining("different prompt"),
	});
});

test("retries a model step after a successful tool without running the tool again", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub, { id: "retry", prompt: "Retry after append." });
	await expect
		.poll(() => stub.turn(runId), { timeout: 5000 })
		.toMatchObject({ state: "completed" });
	expect(await stub.state()).toMatchObject({ text: "Retry after append." });
});

test("lists an empty workspace before the first write and preserves files across a reset", async () => {
	let stub = openFixture();
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const list = {
		code: `import { ls } from "codemode:tools";
export default async function () {
  return await ls({ path: "/workspace" });
}`,
	};
	expect(decode(await stub.workspaceTool("exec", list))).toMatchObject({
		status: "completed",
		activity: [{ name: "ls", status: "completed" }],
		output: { isError: false, details: { path: "/workspace", count: 0, entries: [] } },
	});
	expect(decode(await stub.workspaceTool("exec", appendExecInput("hello")))).toMatchObject({
		status: "completed",
		output: "hello",
	});
	const before = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	expect(decode(await stub.workspaceTool("exec", list))).toMatchObject({
		status: "completed",
		output: { isError: false, details: { count: 1, entries: [{ name: "turn.txt" }] } },
	});
	const after = await stub.state();
	expect(after.instance).not.toBe(before.instance);
	expect(after.text).toBe("hello");
});

test("exposes stock Computer tools inside exec and rejects direct calls", async () => {
	const stub = openFixture();
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const code = `
import * as tools from "codemode:tools";
export default async function () {
  const path = "/workspace/notes.txt";
  const invalid = await tools.write({ path });
  const outside = await tools.write({ path: "/outside.txt", content: "escape" });
  const absent = await tools.read({ path });
  const written = await tools.write({ path, content: "milk" });
  const read = await tools.read({ path });
  return { names: Object.keys(tools).sort(), invalid: invalid.isError, outside: outside.isError,
    absent: absent.isError, written: written.isError, text: read.text };
}`;
	expect(decode(await stub.workspaceTool("exec", { code }))).toMatchObject({
		status: "completed",
		activity: [
			{ name: "write", status: "failed" },
			{ name: "write", status: "failed" },
			{ name: "read", status: "failed" },
			{ name: "write", status: "completed" },
			{ name: "read", status: "completed" },
		],
		output: {
			names: [
				"cancelSchedule",
				"delete",
				"edit",
				"find",
				"grep",
				"listSchedules",
				"ls",
				"read",
				"scheduleTurn",
				"write",
			],
			invalid: true,
			outside: true,
			absent: true,
			written: false,
			text: expect.stringContaining("milk"),
		},
	});
	expect(decode(await stub.workspaceTool("write", { path: "/workspace/notes.txt" }))).toMatchObject(
		{
			status: "failed",
		},
	);
	expect(await stub.workspaceTool("scheduleTurn", null)).toContain("Unknown tool");
	expect(decode(await stub.workspaceTool("exec", { code }, true))).toMatchObject({
		status: "unknown",
	});
});

test("keeps a weekly schedule on local time across daylight-saving changes", () => {
	const schedule = {
		type: "weekly",
		days: ["mon", "tue", "wed", "thu", "fri"],
		time: "08:00",
		timeZone: "America/New_York",
	} as const;
	expect(new Date(nextWeeklyRun(schedule, Date.parse("2026-03-06T13:00:00Z"))).toISOString()).toBe(
		"2026-03-09T12:00:00.000Z",
	);
	expect(new Date(nextWeeklyRun(schedule, Date.parse("2026-10-30T12:00:00Z"))).toISOString()).toBe(
		"2026-11-02T13:00:00.000Z",
	);
});

test("lists and cancels schedules through Code Mode after a Durable Object restart", async () => {
	const stub = openFixture();
	await stub.history({});
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const created = decode(
		await stub.workspaceTool("exec", {
			code: `import { scheduleTurn } from "codemode:tools";
export default async function () {
  return scheduleTurn({
    prompt: "Review workspace changes.",
    when: { type: "weekly", days: ["mon", "fri"], time: "08:00", timeZone: "America/New_York" }
  });
}`,
		}),
	);
	expect(created).toMatchObject({ status: "completed", output: { id: expect.any(String) } });
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	const restarted = env.CHAT_TEST.get(stub.id);
	const cancelled = decode(
		await restarted.workspaceTool("exec", {
			code: `import { listSchedules, cancelSchedule } from "codemode:tools";
export default async function () {
  const { schedules } = await listSchedules();
  const receipt = await cancelSchedule({ id: schedules[0].id });
  const repeated = await cancelSchedule({ id: schedules[0].id });
  return { schedules, receipt, repeated, after: await listSchedules() };
}`,
		}),
	);
	expect(cancelled).toMatchObject({
		status: "completed",
		output: {
			schedules: [expect.objectContaining({ prompt: "Review workspace changes." })],
			receipt: { status: "inactive" },
			repeated: { status: "inactive" },
			after: { schedules: [], nextOffset: null },
		},
	});
});

test("captures script output and confines named Git tools to the workspace", async () => {
	const stub = openFixture();
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const code = `
import * as git from "codemode:git";
export default async function () {
  console.log("starting");
  try {
    await git.status({ dir: "/outside" });
  } catch (error) {
    if (error.code !== "failed") throw error;
    console.error(error.message);
  }
  return { genericGitCommand: "cli" in git };
}`;
	expect(decode(await stub.workspaceTool("exec", { code }))).toMatchObject({
		status: "completed",
		output: {
			value: { genericGitCommand: false },
			stdout: "starting\n",
			stderr: "Git directory must be inside /workspace.\n",
		},
		activity: [{ name: "git.status", status: "failed" }],
	});
});

test("restores native compaction across a reset and pairs the resumed exec with its result", async () => {
	let stub = openFixture();
	const first = await submit(stub, { id: "compact-first", prompt: compactSetupPrompt });
	await expect.poll(() => readTurn(stub, first.runId)).toMatchObject({ state: "completed" });
	const before = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	expect((await stub.state()).instance).not.toBe(before.instance);
	const followUp = await submit(stub, { id: "compact-follow-up", prompt: compactResumePrompt });
	await expect
		.poll(() => readTurn(stub, followUp.runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: compactResumePrompt },
					{ role: "tool-call", name: "exec" },
					{ role: "tool", result: { status: "completed", output: compactReference } },
					{ role: "assistant", text: `Saved ${compactReference}.` },
				],
			},
		});
	expect(await stub.state()).toMatchObject({ text: compactReference });
	expect(JSON.stringify(await stub.history({}))).not.toContain("opaque-fixture-compaction");
});

test("returns invalid tool arguments to the model without writing to the workspace", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub, { id: "bad-append", prompt: "Call append without text." });
	const message = "Provide non-empty JavaScript source in the code argument.";
	await expect
		.poll(() => readTurn(stub, runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: "Call append without text." },
					{ role: "tool-call", name: "exec", input: { code: "" } },
					{ role: "tool", callId: "append-1", result: { status: "failed", message } },
					{ role: "assistant", text: message },
				],
			},
		});
	expect(await stub.state()).toMatchObject({ text: "" });
});

test("stops only the active run and drains a queued follow-up", async () => {
	const stub = openFixture();
	await stub.pause("during-reply");
	const first = await submit(stub, { id: "stop-this", prompt: "Remember something" });
	await expect.poll(() => stub.state()).toMatchObject({ pausedAt: "during-reply" });
	const queued = await submit(stub, { id: "next", prompt: "Remember next" });
	expect(await stub.stop(queued.runId)).toEqual({ runId: queued.runId, stopped: false });
	expect(await stub.stop(first.runId)).toEqual({ runId: first.runId, stopped: true });
	await expect
		.poll(() => stub.turn(first.runId))
		.toMatchObject({ state: "cancelled", transcript: null });
	await stub.release();
	await expect.poll(() => stub.turn(queued.runId)).toMatchObject({ state: "completed" });
	expect((await stub.history({})).entries.map(({ submissionId }) => submissionId)).toEqual([
		"stop-this",
		"stop-this",
		"next",
		"next",
	]);
});

test("a chat socket restores a completed transcript from durable history", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub, { id: "seen", prompt: "Remember milk" });
	await expect.poll(() => stub.turn(runId)).toMatchObject({ state: "completed" });
	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	const response = await env.CHAT_TEST.get(stub.id).fetch(
		new Request(`https://fixture${ChatPath}/live`, { headers: { Upgrade: "websocket" } }),
	);
	const socket = response.webSocket;
	if (!socket) {
		throw new Error("Expected a chat socket");
	}
	const first = new Promise<string>((resolve) => {
		socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
	});
	socket.accept();
	try {
		const frame = Schema.decodeSync(Schema.fromJsonString(ChatEvent))(await first);
		expect(frame).toMatchObject({
			type: "snapshot",
			active: null,
			preview: null,
			page: {
				entries: [
					{ submissionId: "seen", message: { role: "user", text: "Remember milk" } },
					{ submissionId: "seen", message: { role: "assistant", text: "Remembering milk" } },
				],
			},
		});
	} finally {
		socket.close();
	}
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
		reply: unknownMessage,
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
		await stub.discardExecution(runId);
	}

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
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

test("resumes an in-flight script without repeating its completed write", async () => {
	let stub = openFixture();
	const { runId } = await submit(stub, {
		id: "interrupted-exec",
		prompt: "Interrupt after writing.",
	});
	await expect
		.poll(() => stub.state())
		.toMatchObject({ text: "once", pausedAt: "waiting-for-restart" });
	expect(await stub.turn(runId)).toMatchObject({ state: "running" });

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	await runDurableObjectAlarm(stub);

	await expect
		.poll(() => readTurn(stub, runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user" },
					{ role: "tool-call", name: "exec" },
					{
						role: "tool",
						result: {
							status: "completed",
							output: "once",
							activity: expect.arrayContaining([
								expect.objectContaining({
									id: expect.any(String),
									name: "write",
									status: "completed",
									input: expect.objectContaining({
										text: expect.stringContaining('"content": "once"'),
									}),
									output: expect.objectContaining({
										text: expect.stringContaining('"isError": false'),
									}),
								}),
							]),
						},
					},
					{ role: "assistant", text: 'Wrote "once"' },
				],
			},
		});
	expect(await stub.state()).toMatchObject({ text: "once" });
});

test("a read-only exec replays a completed call and retries an interrupted call with the same ID", async () => {
	let stub = openFixture();
	await stub.pause("during-replay-read");
	const { runId } = await submit(stub, { id: "replay", prompt: "Replay two reads." });
	await expect.poll(() => stub.state()).toMatchObject({ pausedAt: "during-replay-read" });
	const { instance } = await stub.state();
	const initial = await stub.replayCalls();
	expect(initial).toEqual({ first: [expect.any(String)], second: [expect.any(String)] });
	expect(await stub.turn(runId)).toMatchObject({ state: "running" });

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	await runDurableObjectAlarm(stub);
	expect((await stub.state()).instance).not.toBe(instance);
	await expect
		.poll(() => stub.replayCalls())
		.toEqual({
			first: initial.first,
			second: [initial.second[0], initial.second[0]],
		});
	await stub.release();

	await expect
		.poll(() => readTurn(stub, runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user" },
					{ role: "tool-call", name: "exec" },
					{
						role: "tool",
						result: {
							status: "completed",
							output: ["first", "second"],
							activity: [
								{ id: initial.first[0], name: "read_first", status: "completed" },
								{ id: initial.second[0], name: "read_second", status: "completed" },
							],
						},
					},
					{ role: "assistant", text: 'Read ["first","second"]' },
				],
			},
		});
	expect(await stub.state()).toMatchObject({ text: "" });
	expect(
		await runInDurableObject(stub, (_, { storage }) => readToolActivity(storage, runId)),
	).toBeUndefined();
});

test("stopping a turn clears the active Code Mode journal", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub, { id: "stop-exec", prompt: "Interrupt after writing." });
	await expect.poll(() => stub.state()).toMatchObject({ text: "once" });
	const { executionId } = await stub.state();
	if (executionId === undefined) {
		throw new Error("Expected the active Computer execution ID");
	}
	expect(await stub.stop(runId)).toEqual({ runId, stopped: true });
	await expect.poll(() => stub.turn(runId)).toMatchObject({ state: "cancelled" });
	expect((await stub.state()).text).toBe("once");
	expect(
		await runInDurableObject(stub, (_, { storage }) => readToolActivity(storage, runId)),
	).toBeUndefined();
	expect(
		await runInDurableObject(stub, (_, { storage }) =>
			Array.from(storage.kv.list({ prefix: `code-mode:${encodeURIComponent(runId)}:` })),
		),
	).toEqual([]);
});

test("replay reports an interrupted file edit and continues with a check of the file", async () => {
	let stub = openFixture();
	await stub.pause("during-replay-edit");
	const { runId } = await submit(stub, {
		id: "edit-replay",
		prompt: "Recover an interrupted edit.",
	});
	await expect
		.poll(() => stub.state())
		.toMatchObject({ pausedAt: "during-replay-edit", text: "seed!" });
	const { instance } = await stub.state();
	const readJournal = () =>
		runInDurableObject(stub, (_, { storage }) =>
			Array.from(storage.kv.list({ prefix: `code-mode:${encodeURIComponent(runId)}:` })),
		);
	expect(await readJournal()).toHaveLength(4);

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	await runDurableObjectAlarm(stub);
	expect((await stub.state()).instance).not.toBe(instance);
	await expect
		.poll(() => readTurn(stub, runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user" },
					{ role: "tool-call", name: "exec" },
					{
						role: "tool",
						result: {
							status: "completed",
							output: { edit: "interrupted", text: "seed!" },
							activity: expect.arrayContaining([
								expect.objectContaining({ name: "edit", status: "interrupted" }),
								expect.objectContaining({ name: "read", status: "completed" }),
							]),
						},
					},
					{ role: "assistant", text: expect.stringMatching(/^Recovered /) },
				],
			},
		});
	expect((await stub.state()).text).toBe("seed!");
	expect(await readJournal()).toEqual([]);
});

test("Git replay reports interrupted branch creation and continues with a status check", async () => {
	let stub = openFixture();
	await stub.pause("during-replay-git");
	const { runId } = await submit(stub, {
		id: "git-replay",
		prompt: "Recover interrupted Git branch creation.",
	});
	await expect.poll(() => stub.state()).toMatchObject({ pausedAt: "during-replay-git" });
	const { instance } = await stub.state();
	const branchAttempts = () =>
		runInDurableObject(stub, (_, { storage }) => storage.kv.get("git-branch-attempts"));
	expect(await branchAttempts()).toBe(1);

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	await runDurableObjectAlarm(stub);
	expect((await stub.state()).instance).not.toBe(instance);
	await expect
		.poll(() => readTurn(stub, runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user" },
					{ role: "tool-call", name: "exec" },
					{
						role: "tool",
						result: {
							status: "completed",
							output: { interrupted: true, checkedStatus: true, branchExists: true },
							activity: expect.arrayContaining([
								expect.objectContaining({ name: "git.branch", status: "interrupted" }),
								expect.objectContaining({ name: "git.status", status: "completed" }),
							]),
						},
					},
					{ role: "assistant", text: expect.stringMatching(/^Recovered /) },
				],
			},
		});
	expect(await branchAttempts()).toBe(1);
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

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
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
					{ role: "tool-call", id: "append-2", name: "exec", input: appendExecInput(" world") },
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

test.each([
	{ kind: "untagged", saved: [] },
	{ kind: "from another adapter", saved: { adapter: "other", version: 1, state: [] } },
	{ kind: "from another version", saved: { adapter: "openai-responses", version: 2, state: [] } },
])("uses transcript context when saved context is $kind", async ({ saved }) => {
	const stub = openFixture();
	const phrase = crypto.randomUUID();
	const first = await submit(stub, remember(phrase));
	await expect
		.poll(() => stub.turn(first.runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
		});
	await runInDurableObject(stub, (_, { storage }) =>
		storage.kv.put("harness-model-context", saved),
	);

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
	expect(
		await runInDurableObject(stub, (_, { storage }) => storage.kv.get("harness-model-context")),
	).toBeUndefined();
});

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

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
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

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
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
	const second = await submit(stub, { id: "next", prompt: "Which earlier prompts did you see?" });

	await expect
		.poll(() => stub.turn(first.runId), { timeout: 5000 })
		.toMatchObject({
			state: "failed",
			error: "The fixture model failed.",
			failure: { code: "model", message: "The fixture model failed." },
			transcript: null,
		});
	await expect
		.poll(() => readTurn(stub, second.runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: "Which earlier prompts did you see?" },
					{ role: "assistant", text: "None." },
				],
			},
		});
	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	expect(await stub.turn(first.runId)).toMatchObject({
		state: "failed",
		failure: { code: "model", message: "The fixture model failed." },
	});
	const { entries } = await stub.history({});
	expect(entries.slice(0, 2).map((entry) => Schema.decodeSync(messageJson)(entry.message))).toEqual(
		[
			{ role: "user", text: "Fail this turn." },
			{ role: "notice", status: "failed", text: "The fixture model failed." },
		],
	);
});
