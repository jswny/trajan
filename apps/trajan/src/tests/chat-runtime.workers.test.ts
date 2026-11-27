import { toolPreviewBytes } from "../chat/tool-presentation";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ToolResult, TurnMessage, TurnTranscript } from "@trajan/harness";
import { Effect, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { ChatEvent, ChatLivePath } from "../chat/protocol";
import { toolActivity } from "../chat/tool-activity";
import { createLiveBrowser } from "../live-browser";
import { nextWeeklyRun } from "../schedule-plan";
import { FileMutationReceipt } from "@trajan/workspace-cloudflare";
import {
	appendExecInput,
	draftExcerpt,
	draftPrompt,
	draftReply,
	handoffPrompt,
	longDraftPrompt,
	retryStreamPrompt,
	skillExecInput,
} from "./chat-runtime-fixture";
import {
	compactReference,
	compactResumePrompt,
	compactSetupPrompt,
	remotePushRecoveryPrompt,
	scheduleOutcomePrompt,
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

test("a recovered exec retains a push that aged out of the live preview", async () => {
	let stub = openFixture();
	const { instance } = await stub.state();
	await stub.pause("during-remote-push");
	const { runId } = await submit(stub, { id: "recover-push", prompt: remotePushRecoveryPrompt });
	await expect.poll(() => stub.state()).toMatchObject({ pausedAt: "during-remote-push" });
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = await waitForRestart(stub, instance);
	await runDurableObjectAlarm(stub);
	await expect
		.poll(() => readTurn(stub, runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: remotePushRecoveryPrompt },
					{ role: "tool-call", id: "call_remote_push" },
					{
						role: "tool",
						result: {
							status: "completed",
							output: "script finished",
							uncertainEffects: [
								{
									name: "git.push",
									message: expect.stringContaining(
										'Verify ref "refs/heads/review" on remote "upstream"',
									),
								},
							],
						},
					},
					{ role: "assistant", text: "Verify the remote branch before retrying the push." },
				],
			},
		});
	const run = await readTurn(stub, runId);
	const tool = run.result?.messages.find((message) => message.role === "tool");
	expect(tool?.result.activity?.map(({ name }) => name)).toEqual([
		"git.push",
		...Array.from({ length: 9 }, () => "read_first"),
	]);
	expect(
		await runInDurableObject(stub, (_, { storage }) => storage.kv.get("git-push-attempts")),
	).toBe(1);
});

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

async function waitForRestart(stub: ReturnType<typeof openFixture>, instance: string) {
	await expect
		.poll(async () => (await env.CHAT_TEST.get(stub.id).state()).instance)
		.not.toBe(instance);
	return env.CHAT_TEST.get(stub.id);
}

async function interruptPausedTurn(stub: ReturnType<typeof openFixture>, point: string) {
	await expect
		.poll(
			async () => {
				const { instance, pausedInstance, pausedAt } = await stub.state();
				return instance === pausedInstance ? pausedAt : undefined;
			},
			{ timeout: 5000 },
		)
		.toBe(point);
	const { instance } = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	const restarted = await waitForRestart(stub, instance);
	await restarted.history({});
	return restarted;
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

test.each([
	{ phase: "before-tool-handoff", handoffs: 0, attempts: 2 },
	{ phase: "after-tool-handoff", handoffs: 1, attempts: 1 },
] as const)(
	"recovers the model decision $phase without repeating exec",
	async ({ phase, handoffs, attempts }) => {
		let stub = openFixture();
		await stub.pause(phase);
		const { runId } = await submit(stub, { id: "tool-handoff", prompt: handoffPrompt });
		const readState = () =>
			runInDurableObject(stub, (_, { storage }) => ({
				attempts: storage.kv.get("handoff-model-attempts"),
				handoffs: Array.from(storage.kv.list({ prefix: `harness-tool-handoff:${runId}:` })).length,
			}));
		await expect
			.poll(() => stub.state(), { timeout: 5000 })
			.toMatchObject({ pausedAt: phase, text: "" });
		expect(await readState()).toEqual({ attempts: 1, handoffs });
		stub = await interruptPausedTurn(stub, phase);
		await stub.release();
		await expect
			.poll(() => readTurn(stub, runId), { timeout: 5000 })
			.toMatchObject({
				state: "completed",
				result: {
					messages: [
						{ role: "user", text: handoffPrompt },
						{ role: "tool-call", id: "append-1" },
						{ role: "tool", callId: "append-1", result: { status: "completed" } },
						{ role: "assistant", text: `Wrote ${JSON.stringify(handoffPrompt)}` },
					],
				},
			});
		expect((await stub.state()).text).toBe(handoffPrompt);
		expect(await readState()).toEqual({ attempts, handoffs: 0 });
	},
);

test.each([
	{ writes: 2, overloaded: false, modelAttempts: 1 },
	{ writes: 3, overloaded: false, modelAttempts: 2 },
	{ writes: 1, overloaded: true, modelAttempts: 2 },
])(
	"recovers after $writes failed handoff writes (overloaded: $overloaded)",
	async ({ writes, overloaded, modelAttempts }) => {
		const stub = openFixture();
		await stub.failToolHandoffWrites(writes, overloaded);
		const { runId } = await submit(stub, { id: "handoff-retry", prompt: handoffPrompt });
		await expect
			.poll(() => stub.turn(runId), { timeout: 5000 })
			.toMatchObject({ state: "completed" });
		expect((await stub.state()).text).toBe(handoffPrompt);
		expect(
			await runInDurableObject(stub, (_, { storage }) => ({
				modelAttempts: storage.kv.get("handoff-model-attempts"),
				fault: storage.kv.get("tool-handoff-write-fault"),
			})),
		).toEqual({ modelAttempts, fault: { remaining: 0, overloaded } });
	},
);

test("stopping a turn discards its committed tool handoff before exec runs", async () => {
	const stub = openFixture();
	await stub.pause("after-tool-handoff");
	const { runId } = await submit(stub, { id: "cancelled-handoff", prompt: handoffPrompt });
	await expect
		.poll(() => stub.state(), { timeout: 5000 })
		.toMatchObject({
			pausedAt: "after-tool-handoff",
			text: "",
		});
	expect(await stub.stop(runId)).toMatchObject({ stopped: true });
	await expect
		.poll(() => stub.turn(runId), { timeout: 5000 })
		.toMatchObject({ state: "cancelled" });
	await stub.release();
	const next = await submit(stub, { id: "after-cancelled-handoff", prompt: "next" });
	await expect
		.poll(() => stub.turn(next.runId), { timeout: 5000 })
		.toMatchObject({ state: "completed" });
	expect((await stub.state()).text).toBe("next");
	expect(
		await runInDurableObject(stub, (_, { storage }) =>
			Array.from(storage.kv.list({ prefix: `harness-tool-handoff:${runId}:` })),
		),
	).toEqual([]);
});

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

const modelInterruptedMessage =
	"The model request was interrupted and its retry budget is exhausted.";

test.each([
	{
		work: "model request",
		point: "between-tools",
		attempts: 4,
		code: "model_interrupted",
		text: modelInterruptedMessage,
	},
	{
		work: "tool step",
		point: "after-write",
		attempts: 5,
		code: "restart_limit",
		text: "The turn stopped after 5 consecutive interruptions of the same tool step.",
	},
] as const)(
	"settles a repeatedly interrupted $work and runs the queued follow-up",
	async ({ attempts, code, point, text }) => {
		let stub = openFixture();
		await stub.pause(point);
		const input = { id: "repeated-reset", prompt: "Append hello, then world." };
		const first = await submit(stub, input);
		const followUp = await submit(stub, {
			id: "follow-up",
			prompt: "Report recent runtime outcomes.",
		});
		for (let count = 0; count < attempts; count++) {
			await expect.poll(() => stub.state()).toMatchObject({ text: "hello" });
			expect(await stub.turn(first.runId)).toMatchObject({ state: "running" });
			expect(await stub.turn(followUp.runId)).toMatchObject({ state: "pending" });
			stub = await interruptPausedTurn(stub, point);
		}
		const failure = { code, message: text };
		await expect.poll(() => stub.turn(first.runId)).toMatchObject({ state: "failed", failure });
		await expect
			.poll(() => readTurn(stub, followUp.runId))
			.toMatchObject({
				state: "completed",
				result: {
					messages: [
						{ role: "user" },
						{
							role: "assistant",
							text: expect.stringContaining(
								'"name":"write","status":"completed","path":"/workspace/turn.txt"',
							),
						},
					],
				},
			});
		const followUpMessages = (await readTurn(stub, followUp.runId)).result?.messages;
		expect(followUpMessages?.at(-1)).toMatchObject({ text: expect.stringContaining(text) });
		const { instance } = await stub.state();
		await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
		stub = await waitForRestart(stub, instance);
		expect(await stub.turn(first.runId)).toMatchObject({ state: "failed", failure });
		const history = await stub.history({});
		expect(
			history.entries
				.filter(({ submissionId }) => submissionId === input.id)
				.map(({ message }) => Schema.decodeSync(messageJson)(message)),
		).toMatchObject([
			{ role: "user", text: input.prompt },
			{ role: "tool-call", id: "append-1" },
			{
				role: "tool",
				callId: "append-1",
				result: {
					status: "completed",
					output: "hello",
					activity: [
						{ name: "read" },
						{
							name: "write",
							status: "completed",
							fileChange: { diff: expect.stringContaining("+hello") },
						},
					],
				},
			},
			{ role: "notice", status: "failed", text },
		]);
		expect((await stub.state()).text).toBe("hello");
	},
	15_000,
);

test("the next checkpoint starts with its own restart budget", async () => {
	let stub = openFixture();
	await stub.pause("between-tools");
	const { runId } = await submit(stub, {
		id: "change-checkpoint",
		prompt: "Append hello, then world.",
	});
	for (let count = 0; count < 3; count++) {
		stub = await interruptPausedTurn(stub, "between-tools");
	}
	await stub.pause("after-write");
	stub = await interruptPausedTurn(stub, "after-write");
	await stub.release();
	await expect.poll(() => stub.turn(runId)).toMatchObject({ state: "completed" });
	expect((await stub.state()).text).toBe("hello world");
}, 15_000);

test("an ordinary model retry and resets share the attempt budget and preserve partial replies", async () => {
	let stub = openFixture();
	await stub.pause("during-reply");
	const { runId } = await submit(stub, { id: "retry-then-reset", prompt: "Retry after append." });
	for (let count = 0; count < 3; count++) {
		stub = await interruptPausedTurn(stub, "during-reply");
		if (count === 0) {
			await expect.poll(() => stub.taskState(runId)).toBe("waiting");
			const { instance } = await stub.state();
			await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
			stub = await waitForRestart(stub, instance);
			await stub.history({});
			expect(await stub.taskState(runId)).toBe("waiting");
		}
	}
	await expect
		.poll(() => stub.turn(runId))
		.toMatchObject({
			state: "failed",
			failure: { code: "model_interrupted", message: modelInterruptedMessage },
		});
	const { entries } = await stub.history({});
	const messages = entries.map(({ message }) => Schema.decodeSync(messageJson)(message));
	expect(messages.filter(({ role }) => role === "interrupted")).toEqual(
		[2, 3, 4].map((attempt) => ({
			role: "interrupted",
			attemptId: `model:1:${attempt}`,
			text: "Wrote",
			truncated: false,
		})),
	);
	expect(messages.filter(({ role }) => role === "assistant")).toEqual([]);
	expect((await stub.state()).text).toBe("Retry after append.");
}, 15_000);

test("batches streamed drafts, archives an interrupted attempt, and gives the next request only the final reply", async () => {
	let stub = openFixture();
	await stub.pause("during-reply");
	const { runId } = await submit(stub, { id: "draft", prompt: draftPrompt });
	const savedDraft = () =>
		runInDurableObject(stub, (_, { storage }) => storage.kv.get(`harness-draft:live:${runId}`));
	await expect.poll(savedDraft, { timeout: 5000 }).toMatchObject({ text: draftExcerpt });
	const interrupted = {
		role: "interrupted",
		attemptId: "model:0:1",
		text: draftExcerpt,
		truncated: false,
	};
	stub = await interruptPausedTurn(stub, "during-reply");
	await expect
		.poll(
			async () => ({
				state: await stub.taskState(runId),
				draft: await runInDurableObject(stub, (_, { storage }) => ({
					live: storage.kv.get(`harness-draft:live:${runId}`),
					interrupted: storage.kv.get(`harness-draft:interrupted:${runId}`),
				})),
			}),
			{ timeout: 5000 },
		)
		.toEqual({ state: "waiting", draft: { live: undefined, interrupted: [interrupted] } });
	await stub.release();
	await expect
		.poll(() => readTurn(stub, runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: draftPrompt },
					interrupted,
					{ role: "assistant", text: draftReply },
				],
			},
		});
	expect(
		await runInDurableObject(
			stub,
			(_, { storage }) => Array.from(storage.kv.list({ prefix: "harness-draft:" })).length,
		),
	).toBe(0);
	const followUp = await submit(stub, {
		id: "context",
		prompt: "Which assistant replies did you receive?",
	});
	await expect
		.poll(() => readTurn(stub, followUp.runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [{ role: "user" }, { role: "assistant", text: JSON.stringify([draftReply]) }],
			},
		});
});

test("a stopped large draft is archived with a Unicode-safe truncation marker", async () => {
	const stub = openFixture();
	await stub.pause("during-reply");
	const { runId } = await submit(stub, { id: "long-draft", prompt: longDraftPrompt });
	await expect.poll(() => stub.state()).toMatchObject({ pausedAt: "during-reply" });
	expect(await stub.stop(runId)).toMatchObject({ stopped: true });
	await expect.poll(() => stub.turn(runId)).toMatchObject({ state: "cancelled" });
	const { entries } = await stub.history({});
	expect(entries.map(({ message }) => Schema.decodeSync(messageJson)(message))).toEqual([
		{ role: "user", text: longDraftPrompt },
		{ role: "interrupted", attemptId: "model:0:1", text: "x".repeat(7999), truncated: true },
		{ role: "notice", status: "cancelled", text: "Stopped" },
	]);
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
    absent: absent.isError, written: written.isError, read };
}`;
	expect(decode(await stub.workspaceTool("exec", { code }))).toMatchObject({
		status: "completed",
		activity: [
			{ name: "write", status: "failed" },
			{ name: "write", status: "failed" },
			{ name: "read", status: "failed" },
			{ name: "write", status: "completed" },
			{
				name: "read",
				status: "completed",
				output: { format: "file", path: "/workspace/notes.txt", text: "milk", truncated: false },
			},
		],
		output: {
			names: [
				"activateSkill",
				"cancelSchedule",
				"delete",
				"edit",
				"find",
				"grep",
				"listSchedules",
				"listSkills",
				"ls",
				"read",
				"readSkillResource",
				"scheduleTurn",
				"write",
			],
			invalid: true,
			outside: true,
			absent: true,
			written: false,
			read: {
				text: "milk",
				isError: false,
				details: {
					path: "/workspace/notes.txt",
					content: "milk",
					startLine: 1,
					endLine: 1,
					totalLines: 1,
					truncated: false,
				},
			},
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

test("discovers workspace skills written in the same exec and loads them after a restart", async () => {
	let stub = openFixture();
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const skills = [{ name: "weekly-brief", description: "Prepare a weekly brief." }];
	const template = "# Weekly template v1\n\n- **Highlight**\n- Next up";
	const saved = {
		skills,
		instructions: expect.stringContaining("Use the weekly template."),
		resource: [
			'<skill_resource name="weekly-brief" path="references/template.md" kind="reference" encoding="text" mimeType="text/markdown">',
			template,
			"</skill_resource>",
		].join("\n"),
	};
	const filePreviews = [
		expect.objectContaining({
			name: "readSkillResource",
			output: {
				format: "file",
				path: "references/template.md",
				text: template,
				truncated: false,
			},
		}),
		expect.objectContaining({
			name: "read",
			output: {
				format: "file",
				path: "/workspace/weekly-brief.ts",
				text: "export function brief(topic: string) {\n  return { title: topic, ready: true };\n}",
				truncated: false,
			},
		}),
	];

	expect(decode(await stub.workspaceTool("exec", skillExecInput(true)))).toMatchObject({
		status: "completed",
		output: { before: [], ...saved },
		activity: expect.arrayContaining(filePreviews),
	});
	const { instance } = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	expect((await stub.state()).instance).not.toBe(instance);
	expect(decode(await stub.workspaceTool("exec", skillExecInput(false)))).toMatchObject({
		status: "completed",
		output: { before: skills, ...saved },
		activity: expect.arrayContaining(filePreviews),
	});
});

test("reports missing skills and rejects resource paths outside a skill folder", async () => {
	const stub = openFixture();
	await stub.workspaceTool("exec", skillExecInput(true));
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const code = `
import { activateSkill, readSkillResource } from "codemode:tools";
export default async function () {
  const errors = [];
  try { await activateSkill({ name: "missing" }); } catch (error) { errors.push(error.code); }
  try { await readSkillResource({ name: "weekly-brief", path: "../private.md" }); } catch (error) { errors.push(error.code); }
  return errors;
}`;
	expect(decode(await stub.workspaceTool("exec", { code }))).toMatchObject({
		status: "completed",
		output: ["failed", "failed"],
		activity: [
			{ name: "activateSkill", status: "failed" },
			{ name: "readSkillResource", status: "failed" },
		],
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

test("uses the later wall time in a spring gap and runs once in a fall overlap", () => {
	const sunday = {
		type: "weekly",
		days: ["sun"],
		time: "02:30",
		timeZone: "America/New_York",
	} as const;
	const gap = nextWeeklyRun(sunday, Date.parse("2026-03-07T00:00:00Z"));
	expect(new Date(gap).toISOString()).toBe("2026-03-08T07:30:00.000Z");
	const repeated = { ...sunday, time: "01:30" };
	const first = nextWeeklyRun(repeated, Date.parse("2026-11-01T00:00:00Z"));
	expect(new Date(first).toISOString()).toBe("2026-11-01T05:30:00.000Z");
	expect(new Date(nextWeeklyRun(repeated, first)).toISOString()).toBe("2026-11-08T06:30:00.000Z");
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

test("rolls back schedule creation when its Code Mode receipt cannot commit", async () => {
	const stub = openFixture();
	const { instance } = await stub.state();
	await stub.pause("during-replay-schedule");
	const { runId } = await submit(stub, {
		id: "schedule-rollback",
		prompt: "Schedule a workspace check.",
	});
	const restarted = await waitForRestart(stub, instance);
	await expect
		.poll(() => readTurn(restarted, runId), { timeout: 7000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: expect.arrayContaining([
					expect.objectContaining({
						role: "tool",
						result: expect.objectContaining({
							status: "completed",
							output: expect.objectContaining({ id: expect.any(String) }),
						}),
					}),
				]),
			},
		});
	expect(
		await runInDurableObject(restarted, (_, { storage }) =>
			storage.kv.get("schedules-before-create"),
		),
	).toEqual({ schedules: [], nextOffset: null });
});

for (const mode of ["before-admission", "after-admission"] as const) {
	test(`reconciles exhausted schedule retries ${mode}`, async () => {
		let stub = openFixture();
		if (mode === "before-admission") {
			const setup = await submit(stub, { id: "compact", prompt: compactSetupPrompt });
			await expect.poll(() => readTurn(stub, setup.runId)).toMatchObject({ state: "completed" });
		}
		await stub.setScheduledFailure(mode);
		const created = Schema.decodeSync(Schema.fromJsonString(ToolResult))(
			await stub.workspaceTool("exec", {
				code: `import { scheduleTurn } from "codemode:tools";
export default async function () {
  return scheduleTurn({ prompt: "Check the workspace on schedule.", when: { type: "weekly", days: ["mon"], time: "08:00", timeZone: "UTC" } });
}`,
			}),
		);
		expect(created.status).toBe("completed");
		await runInDurableObject(stub, async (instance, { storage }) => {
			storage.sql.exec(
				"UPDATE cf_agents_jobs SET time = ? WHERE capability = 'turn-schedules'",
				Date.now(),
			);
			await instance.lifecycle.rearmAlarm();
		});
		await runDurableObjectAlarm(stub);
		const { instance } = await stub.state();
		const historyIncludes =
			mode === "before-admission"
				? "A scheduled task could not be queued after retries."
				: "The scheduled workspace check ran.";
		await expect
			.poll(async () =>
				(await stub.history({})).entries.filter(({ message }) => message.includes(historyIncludes)),
			)
			.toHaveLength(1);
		await expect
			.poll(async () => {
				const [schedule] = await runInDurableObject(stub, (_, { storage }) =>
					storage.sql
						.exec<{ time: number }>(
							"SELECT time FROM cf_agents_jobs WHERE capability = 'turn-schedules'",
						)
						.toArray(),
				);
				return schedule?.time ?? 0;
			})
			.toBeGreaterThan(Date.now());
		await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
		stub = await waitForRestart(stub, instance);
		const { entries } = await stub.history({});
		if (mode === "before-admission") {
			const notices = entries
				.map(({ message }) => Schema.decodeSync(messageJson)(message))
				.filter(({ role }) => role === "notice");
			expect(notices).toEqual([
				{
					role: "notice",
					status: "failed",
					text: expect.stringContaining("Next scheduled run is "),
				},
			]);
			const followUp = await submit(stub, {
				id: "inspect-schedule",
				prompt: scheduleOutcomePrompt,
			});
			await expect
				.poll(() => readTurn(stub, followUp.runId))
				.toMatchObject({
					state: "completed",
					result: {
						messages: [
							{ role: "user", text: scheduleOutcomePrompt },
							{ role: "assistant", text: "The scheduled workspace check was missed." },
						],
					},
				});
		} else {
			expect(entries.map(({ message }) => Schema.decodeSync(messageJson)(message).role)).toEqual([
				"user",
				"assistant",
			]);
		}
	});
}

test("a missed occurrence keeps its report through storage failures, restart, and schedule cancellation", async () => {
	let stub = openFixture();
	await stub.history({});
	await stub.setScheduledFailure("before-admission");
	await stub.failMissedScheduleReports(4);
	const created = Schema.decodeSync(Schema.fromJsonString(ToolResult))(
		await stub.workspaceTool("exec", {
			code: `import { scheduleTurn } from "codemode:tools";
export default async function () {
  return scheduleTurn({ prompt: "Check the workspace on schedule.", when: { type: "weekly", days: ["mon"], time: "08:00", timeZone: "UTC" } });
}`,
		}),
	);
	expect(created.status).toBe("completed");
	const jobs = () =>
		runInDurableObject(stub, (_, { storage }) =>
			storage.sql
				.exec<{ id: string; fn: string; time: number }>(
					"SELECT id, fn, time FROM cf_agents_jobs WHERE capability = 'turn-schedules' ORDER BY fn",
				)
				.toArray(),
		);
	const makeDue = (fn: string, time: number) =>
		runInDurableObject(stub, (_, { storage }) => {
			storage.sql.exec(
				"UPDATE cf_agents_jobs SET time = ? WHERE capability = 'turn-schedules' AND fn = ?",
				time,
				fn,
			);
		});
	const scheduledFor = Date.now() - 1000;
	await makeDue("submit-scheduled-turn", scheduledFor);
	await runDurableObjectAlarm(stub);
	const reportId = expect.stringMatching(new RegExp(`^report:scheduled:.*:${scheduledFor}$`));
	await expect.poll(jobs).toEqual([
		{ id: reportId, fn: "report-missed-scheduled-turn", time: expect.any(Number) },
		{ id: expect.any(String), fn: "submit-scheduled-turn", time: expect.any(Number) },
	]);
	expect((await stub.history({})).entries).toEqual([]);
	const { instance } = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = await waitForRestart(stub, instance);
	await stub.history({});

	const cancelled = Schema.decodeSync(Schema.fromJsonString(ToolResult))(
		await stub.workspaceTool("exec", {
			code: `import { listSchedules, cancelSchedule } from "codemode:tools";
export default async function () {
  const { schedules } = await listSchedules();
  await cancelSchedule({ id: schedules[0].id });
  return { listed: schedules.length, remaining: (await listSchedules()).schedules.length };
}`,
		}),
	);
	expect(cancelled).toMatchObject({ status: "completed", output: { listed: 1, remaining: 0 } });
	const reportRetryTime = Date.now() - 1;
	await makeDue("report-missed-scheduled-turn", reportRetryTime);
	await runDurableObjectAlarm(stub);
	await expect
		.poll(jobs)
		.toEqual([{ id: reportId, fn: "report-missed-scheduled-turn", time: expect.any(Number) }]);
	await expect.poll(async () => (await jobs())[0]?.time).toBeGreaterThan(reportRetryTime + 20_000);
	expect((await stub.history({})).entries).toEqual([]);

	await makeDue("report-missed-scheduled-turn", Date.now() - 1);
	await runDurableObjectAlarm(stub);
	await expect.poll(jobs).toEqual([]);
	const { entries } = await stub.history({});
	expect(entries.map(({ message }) => Schema.decodeSync(messageJson)(message))).toEqual([
		{
			role: "notice",
			status: "failed",
			text: `A scheduled task could not be queued after retries.\n\nScheduled task for ${new Date(scheduledFor).toISOString()}\n\nCheck the workspace on schedule.`,
		},
	]);
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

test("allows Git initialization with missing metadata and rejects symlinked paths", async () => {
	const stub = openFixture();
	await stub.seedGitPathLinks();
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const code = `
import { init, status } from "codemode:git";
export default async function () {
  await init({ dir: "repo" });
  await status({ dir: "repo" });
  const errors = [];
  for (const dir of ["linked-dir", "linked-metadata"]) {
    try { await status({ dir }); }
    catch (error) {
      if (error.code !== "failed") throw error;
      errors.push(error.message);
    }
  }
  return errors;
}`;
	expect(decode(await stub.workspaceTool("exec", { code }))).toMatchObject({
		status: "completed",
		output: [
			"Git directories cannot traverse a symbolic link.",
			"Git directories cannot traverse a symbolic link.",
		],
		activity: [
			{ name: "git.init", status: "completed" },
			{ name: "git.status", status: "completed" },
			{ name: "git.status", status: "failed" },
			{ name: "git.status", status: "failed" },
		],
	});
});

test("Git status sees committed index changes across calls and checkout restores the worktree", async () => {
	const stub = openFixture();
	const decode = Schema.decodeSync(Schema.fromJsonString(ToolResult));
	const code = `
import { init, add, commit, branch, checkout, status } from "codemode:git";
import { read, write } from "codemode:tools";
export default async function () {
  const author = { name: "Trajan fixture", email: "fixture@example.invalid" };
  const path = "/workspace/index-proof.txt";
  await init();
  await write({ path, content: "first" });
  const before = await status();
  await add({ paths: ["index-proof.txt"] });
  const staged = await status();
  await commit({ author, message: "First" });
  await branch({ name: "original" });
  await write({ path, content: "second" });
  await add({ paths: ["index-proof.txt"] });
  await commit({ author, message: "Second" });
  await checkout({ ref: "original" });
  const checkedOut = await read({ path });
  return { before, staged, text: checkedOut.text, after: await status() };
}`;
	expect(decode(await stub.workspaceTool("exec", { code }))).toMatchObject({
		status: "completed",
		output: {
			before: [{ path: "index-proof.txt", index: " ", worktree: "?" }],
			staged: [{ path: "index-proof.txt", index: "A" }],
			text: "first",
			after: [],
		},
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
	expect(
		(await stub.history({})).entries.map(({ submissionId, message }) => ({
			submissionId,
			...Schema.decodeSync(messageJson)(message),
		})),
	).toMatchObject([
		{ submissionId: "stop-this", role: "user" },
		{ submissionId: "stop-this", role: "interrupted", text: "Remem" },
		{ submissionId: "stop-this", role: "notice", text: "Stopped" },
		{ submissionId: "next", role: "user" },
		{ submissionId: "next", role: "assistant" },
	]);
});

test("a chat socket restores a completed transcript from durable history", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub, { id: "seen", prompt: "Remember milk" });
	await expect.poll(() => stub.turn(runId)).toMatchObject({ state: "completed" });
	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	const response = await env.CHAT_TEST.get(stub.id).fetch(
		new Request(`https://fixture${ChatLivePath}`, { headers: { Upgrade: "websocket" } }),
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

test("keeps an exec script and its result on the same history page", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub);
	await expect.poll(() => stub.turn(runId)).toMatchObject({ state: "completed" });

	const page = await stub.history({ limit: 2 });
	expect(page.entries.map(({ message }) => Schema.decodeSync(messageJson)(message))).toMatchObject([
		toolCall,
		{ role: "tool", callId: toolCall.id, result: completedTool },
		{ role: "assistant" },
	]);
	if (page.nextBefore === null) {
		throw new Error("Expected the user message on the preceding page");
	}
	const earlier = await stub.history({ before: page.nextBefore, limit: 1 });
	expect(earlier.entries.map(({ message }) => Schema.decodeSync(messageJson)(message))).toEqual([
		prompt,
	]);
	expect(earlier.nextBefore).toBeNull();
});

test("bounds history by encoded bytes while keeping a cursor to older rows", async () => {
	const stub = openFixture();
	const { runId } = await submit(stub);
	await expect.poll(() => stub.turn(runId)).toMatchObject({ state: "completed" });
	await runInDurableObject(stub, (_, { storage }) => {
		const large = Schema.encodeSync(messageJson)({ role: "assistant", text: "é".repeat(300_000) });
		for (let index = 0; index < 3; index++) {
			storage.sql.exec(
				"INSERT INTO harness_entries (submission_seq, role, message) SELECT seq, 'assistant', ? FROM harness_submissions WHERE run_id = ?",
				large,
				runId,
			);
		}
	});

	const page = await stub.history({});
	expect(page.entries).toHaveLength(1);
	if (page.nextBefore === null) {
		throw new Error("Expected an earlier history cursor");
	}
	const next = await stub.history({ before: page.nextBefore });
	expect(next.entries).toHaveLength(1);
	expect(next.entries[0].id).toBeLessThan(page.entries[0].id);
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
});

test("stopping a turn archives its committed write even without live tool activity", async () => {
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
	const { instance } = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	const restarted = await waitForRestart(stub, instance);
	const messages = (await restarted.history({})).entries.map(({ message }) =>
		Schema.decodeSync(messageJson)(message),
	);
	expect(messages).toMatchObject([
		{ role: "user", text: "Interrupt after writing." },
		{ role: "tool-call", id: "exec-interrupt" },
		{
			role: "tool",
			callId: "exec-interrupt",
			result: {
				status: "unknown",
				activity: expect.arrayContaining([
					{
						id: expect.any(String),
						name: "write",
						status: "completed",
						input: expect.anything(),
						output: expect.anything(),
						fileChange: {
							path: "/workspace/turn.txt",
							kind: "added",
							diff: expect.stringContaining("+once"),
						},
					},
				]),
			},
		},
		{ role: "notice", status: "cancelled", text: "Stopped" },
	]);
	expect(
		await runInDurableObject(restarted, (_, { storage }) =>
			Array.from(storage.kv.list({ prefix: `code-mode:${encodeURIComponent(runId)}:` })),
		),
	).toEqual([]);
	const prompt = "Report recent runtime outcomes.";
	const followUp = await submit(restarted, { id: "inspect-outcome", prompt });
	await expect
		.poll(() => readTurn(restarted, followUp.runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: prompt },
					{
						role: "assistant",
						text: expect.stringContaining(
							'"name":"write","status":"completed","path":"/workspace/turn.txt"',
						),
					},
				],
			},
		});
	const later = await submit(restarted, { id: "inspect-outcome-again", prompt });
	await expect
		.poll(() => readTurn(restarted, later.runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user", text: prompt },
					{ role: "assistant", text: "[]" },
				],
			},
		});
});

test("a later model failure keeps the completed exec and its diff in history", async () => {
	const stub = openFixture();
	const prompt = "Fail the model after writing.";
	const { runId } = await submit(stub, { id: "fail-after-write", prompt });
	await expect.poll(() => stub.turn(runId), { timeout: 7000 }).toMatchObject({ state: "failed" });
	const { entries } = await stub.history({});
	expect(entries.map(({ message }) => Schema.decodeSync(messageJson)(message))).toMatchObject([
		{ role: "user", text: prompt },
		{ role: "tool-call", id: "append-1", input: appendExecInput(prompt) },
		{
			role: "tool",
			callId: "append-1",
			result: {
				status: "completed",
				output: prompt,
				activity: [
					{ name: "read" },
					{
						name: "write",
						status: "completed",
						fileChange: { diff: expect.stringContaining(`+${prompt}`) },
					},
				],
			},
		},
		{ role: "notice", status: "failed", text: "The fixture model failed after writing." },
	]);
});

test("retries an edit rolled back by a restart before its checkpoint", async () => {
	let stub = openFixture();
	const { instance } = await stub.state();
	await stub.pause("during-replay-edit");
	const { runId } = await submit(stub, {
		id: "edit-replay",
		prompt: "Recover an interrupted edit.",
	});
	const readJournal = () =>
		runInDurableObject(stub, (_, { storage }) =>
			Array.from(storage.kv.list({ prefix: `code-mode:${encodeURIComponent(runId)}:` })),
		);
	stub = await waitForRestart(stub, instance);
	expect((await stub.state()).text).toBe("seed");
	await runDurableObjectAlarm(stub);
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
							output: { edit: "completed", text: "seed!" },
							activity: expect.arrayContaining([
								expect.objectContaining({
									name: "write",
									status: "completed",
									fileChange: {
										path: "/workspace/turn.txt",
										kind: "added",
										diff: expect.stringContaining("+seed"),
									},
								}),
								expect.objectContaining({
									name: "edit",
									status: "completed",
									fileChange: {
										path: "/workspace/turn.txt",
										kind: "modified",
										diff: expect.stringContaining("+seed!"),
									},
								}),
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

test("rebuilds both file diffs from completed call checkpoints after a restart", async () => {
	let stub = openFixture();
	const { runId } = await submit(stub, { id: "file-diffs", prompt: "Recover file diffs." });
	await expect.poll(() => stub.state()).toMatchObject({ pausedAt: "waiting-for-restart" });
	const before = (await stub.readSettledTools(runId)).find(({ role }) => role === "tool");
	const changes =
		before?.role === "tool"
			? before.result.activity?.filter((entry) => entry.name === "write" || entry.name === "edit")
			: undefined;
	expect(changes).toMatchObject([
		{
			name: "write",
			fileChange: { kind: "added", diff: expect.stringContaining("+  ready: false,") },
		},
		{
			name: "edit",
			fileChange: {
				kind: "modified",
				diff: expect.stringContaining("-  ready: false,\n+  ready: true,"),
			},
		},
	]);

	await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
	stub = env.CHAT_TEST.get(stub.id);
	await runDurableObjectAlarm(stub);
	await expect.poll(() => readTurn(stub, runId)).toMatchObject({ state: "completed" });
	const message = (await readTurn(stub, runId)).result?.messages.find(
		({ role }) => role === "tool",
	);
	if (message?.role !== "tool" || message.result.status !== "completed") {
		throw new Error("Expected a completed exec");
	}
	expect(message.result.activity?.slice(0, 2)).toEqual(changes);
	const receipts = Schema.decodeUnknownSync(Schema.Array(FileMutationReceipt))(
		message.result.output,
	);
	expect(receipts).toMatchObject([
		{ isError: false, details: { path: "/workspace/report.ts", bytesWritten: 68 } },
		{ isError: false, details: { path: "/workspace/report.ts", bytesWritten: 67 } },
	]);
	expect(message.result.output).toEqual(receipts);
});

test("retries a write rolled back by a restart before its checkpoint", async () => {
	let stub = openFixture();
	const { instance } = await stub.state();
	await stub.pause("during-replay-write");
	const { runId } = await submit(stub, {
		id: "write-replay",
		prompt: "Recover an interrupted write.",
	});
	stub = await waitForRestart(stub, instance);
	expect((await stub.state()).text).toBe("");
	await runDurableObjectAlarm(stub);
	await expect.poll(() => readTurn(stub, runId)).toMatchObject({ state: "completed" });
	const message = (await readTurn(stub, runId)).result?.messages.find(
		(message) => message.role === "tool",
	);
	expect(message?.result).toMatchObject({
		status: "completed",
		output: { outcome: "completed", text: "written before the restart" },
		activity: [
			{ name: "write", status: "completed", fileChange: { kind: "added" } },
			{ name: "read", status: "completed" },
		],
	});
});

test("retries a delete rolled back by a restart before its checkpoint", async () => {
	let stub = openFixture();
	const { instance } = await stub.state();
	await stub.pause("during-replay-delete");
	const { runId } = await submit(stub, {
		id: "delete-replay",
		prompt: "Recover an interrupted delete.",
	});
	stub = await waitForRestart(stub, instance);
	expect((await stub.state()).text).toBe("seed");
	await runDurableObjectAlarm(stub);
	await expect.poll(() => readTurn(stub, runId)).toMatchObject({ state: "completed" });
	const message = (await readTurn(stub, runId)).result?.messages.find(
		(message) => message.role === "tool",
	);
	expect(message?.result).toMatchObject({
		status: "completed",
		output: { deleted: "/workspace/turn.txt", missing: true },
		activity: [
			{ name: "write", status: "completed" },
			{ name: "delete", status: "completed" },
			{ name: "read", status: "failed" },
		],
	});
});

test("rolls back an atomic write that returns a failure after touching the file", async () => {
	const stub = openFixture();
	await stub.pause("reject-atomic-write");
	const { runId } = await submit(stub, {
		id: "rejected-write",
		prompt: "Recover an interrupted write.",
	});
	await expect.poll(() => readTurn(stub, runId)).toMatchObject({ state: "completed" });
	const message = (await readTurn(stub, runId)).result?.messages.find(
		(message) => message.role === "tool",
	);
	expect(message?.result.activity).toMatchObject([{ name: "write", status: "failed" }]);
	expect(message?.result.activity?.[0]).not.toHaveProperty("fileChange");
	expect((await stub.state()).text).toBe("");
});

test.each([
	{ when: "before", prompt: "Recover interrupted Git branch creation." },
	{ when: "after", prompt: "Recover committed Git branch creation." },
])(
	"recovers Git branch creation after a restart $when its checkpoint",
	async ({ when, prompt }) => {
		let stub = openFixture();
		const { instance } = await stub.state();
		if (when === "before") {
			await stub.pause("during-replay-git");
		}
		const { runId } = await submit(stub, { id: "git-replay", prompt });
		const branchAttempts = () =>
			runInDurableObject(stub, (_, { storage }) => storage.kv.get("git-branch-attempts"));
		if (when === "after") {
			await expect.poll(() => stub.state()).toMatchObject({ pausedAt: "waiting-for-restart" });
			await expect(stub.crash()).rejects.toThrow(/forced chat fixture restart|reset/i);
		}
		stub = await waitForRestart(stub, instance);
		expect(await branchAttempts()).toBe(when === "before" ? undefined : 1);
		await runDurableObjectAlarm(stub);
		await expect.poll(() => readTurn(stub, runId)).toMatchObject({ state: "completed" });
		const message = (await readTurn(stub, runId)).result?.messages.find(
			(entry) => entry.role === "tool",
		);
		expect(message?.result).toMatchObject({
			status: "completed",
			output: { checkedStatus: true, branchExists: true },
			activity: expect.arrayContaining([
				expect.objectContaining({ name: "git.branch", status: "completed" }),
				expect.objectContaining({ name: "git.status", status: "completed" }),
			]),
		});
		expect(await branchAttempts()).toBe(1);
	},
);

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
	{
		kind: "malformed for this adapter",
		saved: { adapter: "openai-responses", version: 1, state: { invalid: true } },
	},
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

test("the inbox backs off across a restart after each group of dispatch retries fails", async () => {
	let stub = openFixture();
	await stub.failInboxWake(6);
	const input = remember("the inbox wake recovered");
	const { runId } = await submit(stub, input);
	const wakeState = () =>
		runInDurableObject(stub, async (_, { storage }) => ({
			jobs: storage.sql
				.exec("SELECT time FROM cf_agents_jobs WHERE capability = 'harness-inbox'")
				.toArray(),
			alarm: await storage.getAlarm(),
			backoffMs: storage.kv.get<number>("harness-inbox:wake-backoff"),
			remaining: storage.kv.get<number>("inbox-wake-faults"),
		}));
	const makeWakeDue = () =>
		runInDurableObject(stub, async (instance, { storage }) => {
			// Advance only this job's deadline so the test can drive the actual Lifecycle alarm.
			storage.sql.exec(
				"UPDATE cf_agents_jobs SET time = ? WHERE capability = 'harness-inbox'",
				Date.now(),
			);
			await instance.lifecycle.rearmAlarm();
		});

	await expect.poll(wakeState).toMatchObject({
		jobs: [{ time: expect.any(Number) }],
		alarm: expect.any(Number),
		backoffMs: 30_000,
		remaining: 3,
	});
	const firstWake = await wakeState();
	expect(firstWake.jobs).toEqual([{ time: firstWake.alarm }]);
	expect(await stub.taskState(runId)).toBe("missing");
	const { instance } = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = await waitForRestart(stub, instance);
	await stub.history({});
	expect(await wakeState()).toEqual(firstWake);

	await makeWakeDue();
	await runDurableObjectAlarm(stub);
	await expect.poll(wakeState).toMatchObject({
		jobs: [{ time: expect.any(Number) }],
		alarm: expect.any(Number),
		backoffMs: 60_000,
		remaining: 0,
	});
	expect(await stub.taskState(runId)).toBe("missing");
	expect(await stub.turn(runId)).toMatchObject({ state: "pending" });

	await makeWakeDue();
	await runDurableObjectAlarm(stub);
	await expect.poll(() => readTurn(stub, runId)).toMatchObject({ state: "completed" });
	await expect.poll(wakeState).toMatchObject({ jobs: [], backoffMs: undefined });
	const { entries } = await stub.history({});
	expect(entries.map(({ message }) => Schema.decodeSync(messageJson)(message))).toEqual([
		{ role: "user", text: input.prompt },
		{ role: "assistant", text: "Remembering the inbox wake recovered" },
	]);
});

test("retries a rolled-back transcript write across a restart without replaying model or tool work", async () => {
	let stub = openFixture();
	await stub.setTranscriptWriteFailure(true);
	const first = await submit(stub);
	const followUp = await submit(stub, {
		id: "after-transcript-retry",
		prompt: "Which assistant replies did you receive?",
	});
	await expect.poll(() => stub.taskState(first.runId), { timeout: 5000 }).toBe("waiting");
	expect(await stub.turn(first.runId)).toMatchObject({ state: "running", transcript: null });
	expect(await stub.turn(followUp.runId)).toMatchObject({ state: "pending" });
	expect((await stub.history({})).entries).toEqual([]);
	const { instance, text } = await stub.state();
	expect(text).toBe("hello");

	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = await waitForRestart(stub, instance);
	await stub.setTranscriptWriteFailure(false);

	const reply = 'Wrote "hello"';
	await expect
		.poll(() => readTurn(stub, followUp.runId), { timeout: 7000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: [{ role: "user" }, { role: "assistant", text: JSON.stringify([reply]) }],
			},
		});
	expect(await stub.turn(first.runId)).toMatchObject({ state: "completed", failure: null });
	expect(await stub.state()).toMatchObject({ text: "hello" });
	const history = (await stub.history({})).entries.map(({ message }) =>
		Schema.decodeSync(messageJson)(message),
	);
	expect(history.filter(({ role }) => role === "assistant")).toEqual([
		{ role: "assistant", text: reply },
		{ role: "assistant", text: JSON.stringify([reply]) },
	]);
	expect(history.filter(({ role }) => role === "tool")).toHaveLength(1);
	expect(
		await runInDurableObject(stub, (_, { storage }) =>
			storage.sql
				.exec(
					"SELECT step_name, attempt FROM cf_agents_task_steps WHERE run_id = ? ORDER BY step_name",
					first.runId,
				)
				.toArray(),
		),
	).toEqual([
		{ step_name: "commit-transcript", attempt: expect.any(Number) },
		{ step_name: "model:0", attempt: 1 },
		{ step_name: "model:1", attempt: 1 },
		{ step_name: "tool:0", attempt: 1 },
	]);
});

test("reports an exhausted transcript write separately from a model failure", async () => {
	const stub = openFixture();
	await stub.setTranscriptWriteFailure(true);
	const { runId } = await submit(stub);
	const message = "The model finished, but its reply could not be saved to the conversation.";
	await expect
		.poll(() => stub.turn(runId), { timeout: 22_000 })
		.toMatchObject({
			state: "failed",
			failure: { code: "transcript_commit", message },
		});
	expect(await stub.state()).toMatchObject({ text: "hello" });
	await stub.setTranscriptWriteFailure(false);
	const followUp = await submit(stub, {
		id: "after-transcript-failure",
		prompt: "Report recent runtime outcomes.",
	});
	await expect
		.poll(() => readTurn(stub, followUp.runId))
		.toMatchObject({
			state: "completed",
			result: {
				messages: [{ role: "user" }, { role: "assistant", text: expect.stringContaining(message) }],
			},
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

test("preserves a partial reply and completed tool when the Worker restarts during model backoff", async () => {
	let stub = openFixture();
	const { runId } = await submit(stub, { id: "stream-retry", prompt: retryStreamPrompt });
	await expect.poll(() => stub.taskState(runId), { timeout: 5000 }).toBe("waiting");
	expect(
		await runInDurableObject(stub, (_, { storage }) => ({
			live: storage.kv.get(`harness-draft:live:${runId}`),
			interrupted: storage.kv.get(`harness-draft:interrupted:${runId}`),
		})),
	).toEqual({
		live: undefined,
		interrupted: [{ role: "interrupted", attemptId: "model:1:1", text: "Wrote", truncated: false }],
	});
	const { instance } = await stub.state();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	stub = await waitForRestart(stub, instance);
	await expect
		.poll(() => readTurn(stub, runId), { timeout: 5000 })
		.toMatchObject({
			state: "completed",
			result: {
				messages: [
					{ role: "user" },
					{ role: "tool-call" },
					{ role: "tool" },
					{ role: "interrupted", attemptId: "model:1:1", text: "Wrote" },
					{ role: "assistant", text: `Wrote "${retryStreamPrompt}"` },
				],
			},
		});
	expect(await stub.state()).toMatchObject({ text: retryStreamPrompt });
});

test("settles a permanent model failure after one attempt and proceeds to the next queued submission", async () => {
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
	expect(
		await runInDurableObject(
			stub,
			(_, { storage }) =>
				storage.sql
					.exec(
						"SELECT attempt FROM cf_agents_task_steps WHERE run_id = ? AND step_name = 'model:0'",
						first.runId,
					)
					.one().attempt,
		),
	).toBe(1);
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

const liveViewUrl = "https://live.browser.run/ui/view?mode=tab&wss=fixture";

test.each([
	{ mode: "readonly", expected: 200, status: "open" },
	{ mode: "unguarded", expected: 502, status: undefined },
	{ mode: "replaced", expected: 200, status: "closed" },
] as const)("handles a $mode Live View lease", async ({ mode, expected, status }) => {
	const stub = openFixture();
	const reply = await runInDurableObject(stub, async (_, { storage }) => {
		let request: Parameters<Env["BROWSER"]["getLiveView"]> | undefined;
		const getLiveView: Env["BROWSER"]["getLiveView"] = async (...args) => {
			request = args;
			if (mode === "replaced") {
				await Effect.runPromise(live.changeAvailability("reopened"));
			}
			return {
				id: "lease",
				devtoolsFrontendUrl: liveViewUrl,
				webSocketDebuggerUrl: "wss://browser.invalid",
				options: {
					mode: "tab",
					...(mode !== "unguarded" && { guardrails: { mode: "readonly" } }),
				},
			};
		};
		const live = createLiveBrowser(
			storage,
			{
				liveView: () =>
					Promise.resolve({
						sessionId: "session",
						expiresInMs: 60_000,
						targets: [
							{ type: "page", targetId: "tab", url: liveViewUrl, pageUrl: "https://example.com/" },
						],
					}),
			},
			{ getLiveView },
			() => {},
		);
		await Effect.runPromise(live.changeAvailability("open"));
		const response = await Effect.runPromise(
			live.requestView(
				new Request("https://trajan.invalid/api/chat/browser-view", {
					method: "POST",
					body: JSON.stringify({ id: live.watch()?.id }),
				}),
			),
		);
		const payload: unknown = response.ok ? await response.json() : undefined;
		return {
			status: response.status,
			cache: response.headers.get("Cache-Control"),
			payload,
			request,
		};
	});
	expect(reply.status).toBe(expected);
	expect(reply.cache).toBe("no-store");
	expect(reply.request).toEqual([
		"session",
		{ targetId: "tab", mode: "tab", expiresInMs: 60_000, guardrails: { mode: "readonly" } },
	]);
	if (status === undefined) {
		expect(reply.payload).toBeUndefined();
	} else {
		expect(reply.payload).toMatchObject({ status, ...(status === "open" && { url: liveViewUrl }) });
	}
});
