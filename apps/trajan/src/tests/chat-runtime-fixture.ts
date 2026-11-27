import { codeModeError } from "@trajan/code-mode";
import { clearCodeModeRun } from "@trajan/code-mode-cloudflare";
import type { CodeModeTool } from "@trajan/code-mode";
import { createCodeModeFixture } from "./code-mode-fixture";
import {
	TurnIoError,
	ToolResult,
	TurnModel,
	TurnModelError,
	TurnSubmission,
	TurnTools,
} from "@trajan/harness";
import type { TurnModelEvent, TurnModelResponse } from "@trajan/harness";
import { Cause, Effect, Exit, Layer, Option, Predicate, Schema, Stream } from "effect";
import { TrajanChatObject } from "../chat/worker-host";
import { createChatExec } from "../chat/exec";
import { createScheduleTools, scheduleInstructions } from "../schedule-tools";
import { createTrajanWorkspace, workspaceToolset } from "../workspace";
import {
	compactReference,
	compactResumePrompt,
	compactSetupPrompt,
	createOpenAiResponsesFixture,
	remotePushRecoveryPrompt,
	scheduleOutcomePrompt,
} from "./openai-responses-fixture";

const chatFixtureReset = "Forced chat fixture restart";
const mermaidPrompt = "Show the delivery flow.";
export const draftPrompt = "Stream a draft recovery example.";
export const draftExcerpt = "The workspace is ready.\n\nI saved the checklist.";
export const draftReply = `${draftExcerpt}\n\nThe final check passed.`;
export const longDraftPrompt = "Stream an oversized draft.";
const longDraft = `${"x".repeat(7999)}📝followed by more text`;
const openMermaidFence = `\`\`\`mermaid
flowchart TD
  accTitle: Delivery flow
  A[Queued] --> B[Running]
`;
const excerptLengths = new Map([
	[mermaidPrompt, openMermaidFence.length],
	[draftPrompt, draftExcerpt.length],
	[longDraftPrompt, longDraft.length],
]);
type PausePoint =
	| "before-task"
	| "after-write"
	| "between-tools"
	| "during-reply"
	| "waiting-for-restart"
	| "after-commit"
	| "during-replay-read"
	| "during-replay-write"
	| "during-replay-edit"
	| "during-replay-delete"
	| "reject-atomic-write"
	| "during-replay-git"
	| "during-remote-push"
	| "during-replay-schedule"
	| "code-mode-read"
	| "code-mode-edit"
	| "code-mode-browser"
	| "code-mode-settle"
	| "code-mode-branch";
const workspaceFile = "/workspace/turn.txt";
const replayPrompt = "Replay two reads.";
const replayCall = "exec-replay";
const writeReplayPrompt = "Recover an interrupted write.";
const editReplayPrompt = "Recover an interrupted edit.";
const editReplayCall = "exec-replay-edit";
const deleteReplayPrompt = "Recover an interrupted delete.";
const gitReplayPrompt = "Recover interrupted Git branch creation.";
const gitCommittedPrompt = "Recover committed Git branch creation.";
const gitReplayCall = "exec-replay-git";
const scheduledPrompt = "Check the workspace on schedule.";
const diffPrompt = "Show file diffs.";
const recoverDiffPrompt = "Recover file diffs.";
const decodeSubmission = Schema.decodeUnknownOption(TurnSubmission);
export function appendExecInput(text: string) {
	return {
		code: `
import { read, write } from "codemode:tools";
export default async function () {
  const path = ${JSON.stringify(workspaceFile)};
  const previous = await read({ path });
  const content = (previous.isError ? "" : previous.text) + ${JSON.stringify(text)};
  const result = await write({ path, content });
  if (result.isError) throw new Error(result.text);
  return content;
}`,
	};
}

export function skillExecInput(save: boolean) {
	return {
		code: `
import { activateSkill, listSkills, read, readSkillResource, write } from "codemode:tools";
export default async function () {
  const name = "weekly-brief";
  const path = "references/template.md";
  const sourcePath = "/workspace/weekly-brief.ts";
  const before = await listSkills();
  ${
		save
			? `
  const folder = "/workspace/.agents/skills/" + name;
  const file = await write({ path: folder + "/SKILL.md", content: "---\\nname: weekly-brief\\ndescription: Prepare a weekly brief.\\n---\\nUse the weekly template." });
  if (file.isError) throw new Error(file.text);
  const template = await write({ path: folder + "/" + path, content: "# Weekly template v1\\n\\n- **Highlight**\\n- Next up" });
  if (template.isError) throw new Error(template.text);
  const written = await write({ path: sourcePath, content: "export function brief(topic: string) {\\n  return { title: topic, ready: true };\\n}" });
  if (written.isError) throw new Error(written.text);`
			: ""
	}
  const skills = await listSkills();
  const instructions = await activateSkill({ name });
  const resource = await readSkillResource({ name, path });
  const source = await read({ path: sourcePath });
  if (source.isError) throw new Error(source.text);
  return { before, skills, instructions, resource };
}`,
	};
}

function isMissing(error: unknown): boolean {
	return Predicate.hasProperty(error, "code") && error.code === "ENOENT";
}

export class ChatTestObject extends TrajanChatObject {
	readonly #instance = crypto.randomUUID();
	#atomicFault: PausePoint | undefined;
	readonly #workspace = createTrajanWorkspace(this.ctx);
	readonly #scheduleTools = createScheduleTools(this.schedules);
	protected readonly chatExec = this.#createTools();
	readonly #responses = createOpenAiResponsesFixture(
		this.chatExec.declaration,
		appendExecInput(compactReference),
	);
	readonly #codeMode = createCodeModeFixture(
		this.#workspace,
		this.ctx.storage,
		this.env.LOADER,
		(point, signal) => this.#pauseAt(point, signal),
	);
	readSettledTools(runId: string) {
		return this.chatExec.readSettledTools(runId);
	}

	#createTools() {
		const { catalog, instructions } = workspaceToolset(this.#workspace);
		const files = catalog["codemode:tools"];
		const git = catalog["codemode:git"];
		const storage = this.ctx.storage;
		const read = (name: "first" | "second"): CodeModeTool => ({
			replay: "safe",
			run: Effect.fnUntraced(function* (
				this: ChatTestObject,
				_input: Schema.Json,
				{ callId, signal }: Parameters<CodeModeTool["run"]>[1],
			) {
				const key = `replay-${name}`;
				const calls = storage.kv.get<Array<string>>(key) ?? [];
				storage.kv.put(key, [...calls, callId]);
				if (name === "second") {
					yield* Effect.tryPromise({
						try: () => this.#pauseAt("during-replay-read", signal),
						catch: codeModeError,
					});
				}
				return name;
			}).bind(this),
		});
		const faultBeforeCommit = (tool: CodeModeTool, point: PausePoint): CodeModeTool => ({
			...tool,
			run: (input, context) =>
				tool.run(input, context).pipe(
					Effect.map((value) => {
						if (this.#atomicFault === point && !tool.isError?.(value)) {
							this.ctx.abort(chatFixtureReset);
						}
						if (point === "during-replay-write" && this.#atomicFault === "reject-atomic-write") {
							this.#atomicFault = undefined;
							return { text: "Fixture rejected the write.", isError: true };
						}
						return value;
					}),
				),
		});
		const branch = faultBeforeCommit(git.branch, "during-replay-git");
		const scheduleTools = this.#scheduleTools;
		const schedule = faultBeforeCommit(scheduleTools.scheduleTurn, "during-replay-schedule");
		return createChatExec(this.env.LOADER, storage, {
			instructions: `${instructions}\n${scheduleInstructions}`,
			catalog: {
				"codemode:tools": {
					...files,
					...scheduleTools,
					scheduleTurn: {
						...schedule,
						run: (input, context) =>
							scheduleTools.listSchedules.run(null, context).pipe(
								Effect.tap((before) =>
									Effect.sync(() => storage.kv.put("schedules-before-create", before)),
								),
								Effect.andThen(schedule.run(input, context)),
							),
					},
					write: faultBeforeCommit(files.write, "during-replay-write"),
					edit: faultBeforeCommit(files.edit, "during-replay-edit"),
					delete: faultBeforeCommit(files.delete, "during-replay-delete"),
					read_first: read("first"),
					read_second: read("second"),
					wait_for_restart: {
						replay: "safe",
						run: (_input, { callId, signal }) =>
							Effect.tryPromise({
								try: async () => {
									const key = `fixture-wait:${callId}`;
									if (!storage.kv.get(key)) {
										storage.kv.put(key, true);
										await storage.put("pausedAt", "waiting-for-restart");
										signal.throwIfAborted();
										await new Promise<void>((resolve) => {
											signal.addEventListener("abort", () => resolve(), { once: true });
										});
										signal.throwIfAborted();
									}
									return null;
								},
								catch: codeModeError,
							}),
					},
				},
				"codemode:git": {
					...git,
					push: {
						...git.push,
						run: (_input, { signal }) =>
							Effect.tryPromise({
								try: async () => {
									storage.kv.put(
										"git-push-attempts",
										(storage.kv.get<number>("git-push-attempts") ?? 0) + 1,
									);
									await this.#pauseAt("during-remote-push", signal);
									return null;
								},
								catch: codeModeError,
							}),
					},
					branch: {
						...branch,
						run: (input, context) =>
							Effect.sync(() => {
								storage.kv.put(
									"git-branch-attempts",
									(storage.kv.get<number>("git-branch-attempts") ?? 0) + 1,
								);
							}).pipe(Effect.andThen(branch.run(input, context))),
					},
				},
			},
		});
	}

	protected override submitEffect(input: unknown) {
		const submission = decodeSubmission(input);
		if (
			!(
				Option.isSome(submission) &&
				submission.value.id.startsWith("scheduled:") &&
				submission.value.prompt.endsWith(scheduledPrompt)
			)
		) {
			return super.submitEffect(input);
		}
		const mode = this.ctx.storage.kv.get<string>("scheduled-failure");
		if (mode === "before-admission") {
			return Effect.fail(
				new TurnIoError({
					operation: "submit scheduled turn",
					cause: "Fixture prevented admission.",
				}),
			);
		}
		return super.submitEffect(input).pipe(
			Effect.tap((receipt) =>
				receipt.accepted || mode === "after-admission"
					? Effect.fail(
							new TurnIoError({
								operation: "submit scheduled turn",
								cause: "Fixture dropped the receipt.",
							}),
						)
					: Effect.void,
			),
		);
	}

	setScheduledFailure(mode: "before-admission" | "after-admission") {
		return this.ctx.storage.put("scheduled-failure", mode);
	}

	failMissedScheduleReports(attempts: number) {
		return this.ctx.storage.put("missed-report-failures", attempts);
	}

	protected override recordUnadmittedSubmission(
		submission: typeof TurnSubmission.Type,
		text: string,
	) {
		return Effect.suspend(() => {
			const kv = this.ctx.storage.kv;
			const failures = kv.get<number>("missed-report-failures") ?? 0;
			if (failures === 0) {
				return super.recordUnadmittedSubmission(submission, text);
			}
			kv.put("missed-report-failures", failures - 1);
			return Effect.fail(
				new TurnIoError({
					operation: "record missed submission",
					cause: "Fixture could not write the notice.",
				}),
			);
		});
	}

	readonly #execute = Effect.fn("chat.fixture.executeTool")(function* (
		this: ChatTestObject,
		...args: Parameters<TurnTools["Service"]["execute"]>
	) {
		const [call, attempt] = args;
		if (call.id === "exec-interrupt") {
			yield* Effect.promise(() => this.ctx.storage.put("executionId", attempt.idempotencyKey));
		}
		const result = yield* this.chatExec.service.execute(...args);
		if (result.status === "completed") {
			// Pause after Code Mode settles while the turn's checkpoint is still open.
			yield* Effect.tryPromise({
				try: (signal) => this.#pauseAt("after-write", signal, attempt.idempotencyKey),
				catch: (cause) => new TurnIoError({ operation: call.name, cause }),
			});
		}
		return result;
	});

	readonly #fakeComplete = Effect.fnUntraced(function* (
		this: ChatTestObject,
		messages: Parameters<TurnModel["Service"]["stream"]>[0],
	): Effect.fn.Return<TurnModelResponse, TurnModelError> {
		const user = messages.findLast((message) => message.role === "user");
		const last = messages.at(-1);
		const appendTwice = user?.text === "Append hello, then world.";
		if (last?.role === "user" && last.text === "Report recent runtime outcomes.") {
			return {
				role: "assistant",
				text: JSON.stringify(messages.filter(({ role }) => role === "runtime-outcome")),
			};
		}
		if (last?.role === "user" && last.text === "Fail this turn.") {
			return yield* new TurnModelError({
				message: "The fixture model failed.",
			});
		}
		if (last?.role === "user" && last.text === draftPrompt) {
			return { role: "assistant", text: draftReply };
		}
		if (last?.role === "user" && last.text === longDraftPrompt) {
			return { role: "assistant", text: longDraft };
		}
		if (last?.role === "user" && last.text === "Which assistant replies did you receive?") {
			const replies = messages.flatMap((message) =>
				message.role === "assistant" ? [message.text] : [],
			);
			return { role: "assistant", text: JSON.stringify(replies) };
		}
		if (last?.role === "user" && last.text.startsWith("Remember ")) {
			return { role: "assistant", text: `Remembering ${last.text.slice("Remember ".length)}` };
		}
		if (last?.role === "user" && (last.text === diffPrompt || last.text === recoverDiffPrompt)) {
			return {
				role: "tool-call",
				id: "exec-file-diffs",
				name: "exec",
				input: {
					code: `import { edit, write, wait_for_restart } from "codemode:tools";
export default async function () {
  const path = "/workspace/report.ts";
  const written = await write({ path, content: 'export const report = {\\n  title: "Weekly brief",\\n  ready: false,\\n};\\n' });
  if (written.isError) throw new Error(written.text);
  const edited = await edit({ path, edits: [{ oldText: "ready: false", newText: "ready: true" }] });
  if (edited.isError) throw new Error(edited.text);
  ${last.text === recoverDiffPrompt ? "await wait_for_restart();" : ""}
  return [written, edited];
}`,
				},
			};
		}
		if (
			last?.role === "user" &&
			(last.text === "Save the weekly brief skill." || last.text === "Use the weekly brief skill.")
		) {
			return {
				role: "tool-call",
				id: "exec-skill",
				name: "exec",
				input: skillExecInput(last.text === "Save the weekly brief skill."),
			};
		}
		if (last?.role === "user" && last.text === replayPrompt) {
			return {
				role: "tool-call",
				id: replayCall,
				name: "exec",
				input: {
					code: `import { read_first, read_second } from "codemode:tools";
export default async function () {
  return [await read_first(), await read_second()];
}`,
				},
			};
		}
		if (last?.role === "user" && last.text === "Recover a file named with time and randomness.") {
			return {
				role: "tool-call",
				id: "exec-replay-runtime",
				name: "exec",
				input: {
					code: `import { now, random, randomUUID } from "codemode:runtime";
import { read, read_second, write } from "codemode:tools";
export default async function () {
  const path = "/workspace/" + await now() + "-" + await randomUUID() + ".txt";
  const sample = await random();
  if (!(sample >= 0 && sample < 1)) throw new Error("Expected a sample in [0, 1)");
  const content = String(sample);
  const written = await write({ path, content });
  if (written.isError) throw new Error(written.text);
  await read_second();
  const restored = await read({ path });
  if (restored.isError || restored.text !== content) throw new Error("Expected the original file");
  return path;
}`,
				},
			};
		}
		if (last?.role === "user" && last.text === editReplayPrompt) {
			return {
				role: "tool-call",
				id: editReplayCall,
				name: "exec",
				input: {
					code: `import { edit, read, write } from "codemode:tools";
export default async function () {
  const path = ${JSON.stringify(workspaceFile)};
  const seed = await write({ path, content: "seed" });
  if (seed.isError) throw new Error(seed.text);
  const before = await read({ path });
  if (before.isError || before.text !== "seed") throw new Error("First read was not replayed");
  let outcome = "completed";
  try {
    const changed = await edit({ path, edits: [{ oldText: "seed", newText: "seed!" }] });
    if (changed.isError) throw new Error(changed.text);
  } catch (error) {
    if (error.code !== "interrupted") throw error;
    outcome = error.code;
  }
  const result = await read({ path });
  if (result.isError) throw new Error(result.text);
  return { edit: outcome, text: result.text };
}`,
				},
			};
		}
		if (last?.role === "user" && last.text === writeReplayPrompt) {
			return {
				role: "tool-call",
				id: "exec-replay-write",
				name: "exec",
				input: {
					code: `import { read, write } from "codemode:tools";
export default async function () {
  const path = ${JSON.stringify(workspaceFile)};
  let outcome = "completed";
  try {
    const written = await write({ path, content: "written before the restart" });
    if (written.isError) throw new Error(written.text);
  } catch (error) {
    if (error.code !== "interrupted") throw error;
    outcome = error.code;
  }
  const file = await read({ path });
  if (file.isError) throw new Error(file.text);
  return { outcome, text: file.text };
}`,
				},
			};
		}
		if (last?.role === "user" && last.text === deleteReplayPrompt) {
			return {
				role: "tool-call",
				id: "exec-replay-delete",
				name: "exec",
				input: {
					code: `import { delete as remove, read, write } from "codemode:tools";
export default async function () {
  const path = ${JSON.stringify(workspaceFile)};
  const seed = await write({ path, content: "seed" });
  if (seed.isError) throw new Error(seed.text);
  const deleted = await remove({ path });
  if (deleted.isError) throw new Error(deleted.text);
  return { deleted: deleted.details.deleted, missing: (await read({ path })).isError };
}`,
				},
			};
		}
		if (
			last?.role === "user" &&
			(last.text === gitReplayPrompt || last.text === gitCommittedPrompt)
		) {
			return {
				role: "tool-call",
				id: gitReplayCall,
				name: "exec",
				input: {
					code: `import { init, add, commit, branch, branches, status } from "codemode:git";
import { write, wait_for_restart } from "codemode:tools";
export default async function () {
  await write({ path: "/workspace/seed.txt", content: "seed" });
  await init();
  await add({ paths: ["seed.txt"] });
  await commit({ message: "Seed replay fixture", author: { name: "Trajan fixture", email: "fixture@example.invalid" } });
  await branch({ name: "replay-proof" });
  ${last.text === gitCommittedPrompt ? "await wait_for_restart();" : ""}
  const checkedStatus = Array.isArray(await status());
  const branchExists = (await branches()).includes("replay-proof");
  return { checkedStatus, branchExists };
}`,
				},
			};
		}
		if (last?.role === "user" && last.text === "Run a workspace module.") {
			return {
				role: "tool-call",
				id: "exec-1",
				name: "exec",
				input: {
					code: `import { read, write } from "codemode:tools";
export default async function () {
  const path = "/workspace/module.txt";
  const written = await write({ path, content: "hello" });
  const [found, missing] = await Promise.all([read({ path }), read({ path: "/workspace/missing.txt" })]);
  if (written.isError || found.isError || !missing.isError) throw new Error("Unexpected tool result");
  return 42;
}`,
				},
			};
		}
		if (
			last?.role === "user" &&
			(last.text === "Schedule a workspace check." ||
				last.text === "Schedule a workspace check and wait.")
		) {
			return {
				role: "tool-call",
				id: "exec-schedule",
				name: "exec",
				input: {
					code: `import { scheduleTurn, wait_for_restart } from "codemode:tools";
import { now } from "codemode:runtime";
export default async function () {
  const receipt = await scheduleTurn({
    prompt: ${JSON.stringify(scheduledPrompt)},
    when: { type: "once", at: new Date(await now() + 3000).toISOString() }
  });
  ${last.text.endsWith("and wait.") ? "await wait_for_restart();" : ""}
  return receipt;
}`,
				},
			};
		}
		if (last?.role === "user" && last.text.endsWith(scheduledPrompt)) {
			return { role: "assistant", text: "The scheduled workspace check ran." };
		}
		if (last?.role === "user" && last.text === "Fail Code Mode after a write.") {
			return {
				role: "tool-call",
				id: "exec-1",
				name: "exec",
				input: {
					code: `import { write } from "codemode:tools";
export default async function () {
  const result = await write({ path: ${JSON.stringify(workspaceFile)}, content: "written" });
  if (result.isError) throw new Error(result.text);
  throw new Error("Script failed after writing.");
}`,
				},
			};
		}
		if (last?.role === "user" && last.text === "Interrupt after writing.") {
			return {
				role: "tool-call",
				id: "exec-interrupt",
				name: "exec",
				input: {
					code: `import { read, write, wait_for_restart } from "codemode:tools";
export default async function () {
  const path = ${JSON.stringify(workspaceFile)};
  const previous = await read({ path });
  const content = (previous.isError ? "" : previous.text) + "once";
  const result = await write({ path, content });
  if (result.isError) throw new Error(result.text);
  await wait_for_restart();
  return content;
}`,
				},
			};
		}
		if (last?.role === "user" && last.text === "Show wide code") {
			return {
				role: "assistant",
				text: `\`\`\`js\nconst message = "${"wide ".repeat(35)}";\n\`\`\``,
			};
		}
		if (last?.role === "user" && last.text === mermaidPrompt) {
			return {
				role: "assistant",
				text: `${openMermaidFence}  B --> C[Delivered]
  click A "https://example.com"
\`\`\`

~~~mermaid
sequenceDiagram
  Alice->>Bob: Confirm delivery
~~~`,
			};
		}
		if (last?.role === "user" && last.text === "Show invalid Mermaid.") {
			return { role: "assistant", text: "```mermaid\nnot a Mermaid diagram\n```" };
		}
		if (last?.role === "user" && last.text === "Show the delivery breakdown.") {
			return {
				role: "assistant",
				text: '```mermaid\npie\n  title Delivery breakdown\n  "Delivered": 8\n  "Queued": 2\n```',
			};
		}
		if (last?.role === "user" && last.text === "What did I ask you to remember?") {
			const memory = messages.findLast(
				(message) => message.role === "assistant" && message.text.startsWith("Remembering "),
			);
			return {
				role: "assistant",
				text:
					memory?.role === "assistant" ? memory.text.slice("Remembering ".length) : "I don't know.",
			};
		}
		if (last?.role === "user" && last.text === "Which earlier prompts did you see?") {
			const earlier = messages.slice(0, -1).filter((message) => message.role === "user");
			return { role: "assistant", text: earlier.map(({ text }) => text).join(", ") || "None." };
		}
		if (last?.role === "tool") {
			if (user?.text === "Fail the model after writing.") {
				return yield* new TurnModelError({ message: "The fixture model failed after writing." });
			}
			if (last.callId === "exec-file-diffs" && last.result.status === "completed") {
				return { role: "assistant", text: "Updated the report." };
			}
			if (user?.text === "Retry after append.") {
				const alreadyFailed = yield* Effect.promise(() =>
					this.ctx.storage.get<boolean>("retry-once"),
				);
				if (!alreadyFailed) {
					yield* Effect.promise(() => this.ctx.storage.put("retry-once", true));
					return yield* new TurnModelError({ message: "Temporary fixture model failure." });
				}
			}
			if (appendTwice && last.callId === "append-1") {
				yield* Effect.tryPromise({
					try: (signal) => this.#pauseAt("between-tools", signal),
					catch: (cause) => new TurnModelError({ message: "Fixture model pause failed.", cause }),
				});
				return {
					role: "tool-call",
					id: "append-2",
					name: "exec",
					input: appendExecInput(" world"),
				};
			}
			const { result } = last;
			const verb =
				last.callId === "exec-schedule"
					? "Scheduled"
					: last.callId === editReplayCall || last.callId === gitReplayCall
						? "Recovered"
						: user?.text === replayPrompt
							? "Read"
							: "Wrote";
			return {
				role: "assistant",
				text:
					result.status === "completed"
						? `${verb} ${JSON.stringify(result.output)}`
						: result.message,
			};
		}
		return {
			role: "tool-call",
			id: "append-1",
			name: "exec",
			input:
				user?.text === "Call append without text."
					? { code: "" }
					: appendExecInput(appendTwice ? "hello" : (user?.text ?? "")),
		};
	});

	protected readonly turnLayer = Layer.merge(
		Layer.succeed(
			TurnModel,
			TurnModel.of({
				contextFormat: this.#responses.contextFormat,
				contextSchema: this.#responses.contextSchema,
				stream: (messages, options) => {
					const user = messages.findLast((message) => message.role === "user");
					if (
						user?.text === compactSetupPrompt ||
						user?.text === compactResumePrompt ||
						user?.text === remotePushRecoveryPrompt ||
						user?.text === scheduleOutcomePrompt
					) {
						return this.#responses.stream(messages, options);
					}
					return Stream.unwrap(
						Effect.map(this.#fakeComplete(messages), (response) => {
							const end = Stream.succeed<TurnModelEvent>({ type: "response", response });
							if (response.role !== "assistant") {
								return end;
							}
							const excerpt = response.text.slice(0, excerptLengths.get(user?.text ?? "") ?? 5);
							const deltas =
								user?.text === draftPrompt ? [excerpt.slice(0, 5), excerpt.slice(5)] : [excerpt];
							return Stream.fromIterable(deltas).pipe(
								Stream.map((text): TurnModelEvent => ({ type: "text-delta", text })),
								Stream.concat(
									Stream.fromEffect(
										Effect.tryPromise({
											try: (signal) => this.#pauseAt("during-reply", signal),
											catch: (cause) =>
												new TurnModelError({ message: "Fixture model pause failed.", cause }),
										}).pipe(
											Effect.as<TurnModelEvent>({
												type: "text-delta",
												text: response.text.slice(excerpt.length),
											}),
										),
									),
								),
								Stream.concat(end),
							);
						}),
					);
				},
			}),
		),
		Layer.succeed(TurnTools, TurnTools.of({ execute: (...args) => this.#execute(...args) })),
	);

	protected override async onTurnPhase(phase: "before-task" | "after-commit", signal: AbortSignal) {
		if (phase === "before-task") {
			const kv = this.ctx.storage.kv;
			const remaining = kv.get<number>("inbox-wake-faults") ?? 0;
			if (remaining > 0) {
				kv.put("inbox-wake-faults", remaining - 1);
				await this.ctx.storage.sync();
				throw new Error("Fixture failed to start the inbox task.");
			}
		}
		await this.#pauseAt(phase, signal);
	}

	failInboxWake(attempts: number) {
		return this.ctx.storage.put("inbox-wake-faults", attempts);
	}

	async setTranscriptWriteFailure(fail: boolean) {
		await this.lifecycle.start();
		const { storage } = this.ctx;
		storage.sql.exec(
			fail
				? `CREATE TRIGGER IF NOT EXISTS fixture_reject_transcript BEFORE INSERT ON harness_entries
				   WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'Fixture transcript write failed'); END`
				: "DROP TRIGGER IF EXISTS fixture_reject_transcript",
		);
		await storage.sync();
	}

	async makeRetryDue(retry: "inbox-wake" | "missed-schedule") {
		const { storage } = this.ctx;
		if (retry === "inbox-wake" && storage.kv.get("harness-inbox:wake-backoff") === undefined) {
			return false;
		}
		const [capability, fn] =
			retry === "inbox-wake"
				? ["harness-inbox", "wake"]
				: ["turn-schedules", "report-missed-scheduled-turn"];
		const now = Date.now();
		// Move a persisted retry deadline forward and let the normal alarm dispatch it.
		const jobs = storage.sql
			.exec(
				"UPDATE cf_agents_jobs SET time = ? WHERE capability = ? AND fn = ? AND time > ? RETURNING id",
				now,
				capability,
				fn,
				now,
			)
			.toArray();
		if (jobs.length === 0) {
			return false;
		}
		await this.lifecycle.rearmAlarm();
		return true;
	}

	onRequest(request: Request) {
		return Effect.runPromise(this.chatRequest(request));
	}

	#readWorkspaceText() {
		return this.#workspace.fs.readFile(workspaceFile, "utf8").catch((error: unknown) => {
			if (isMissing(error)) {
				return "";
			}
			throw error;
		});
	}

	async state() {
		const executionId = await this.ctx.storage.get<string>("executionId");
		const pausedAt = await this.ctx.storage.get<PausePoint>("pausedAt");
		const pausedInstance = await this.ctx.storage.get<string>("pausedInstance");
		const text = await this.#readWorkspaceText();
		return { instance: this.#instance, executionId, pausedAt, pausedInstance, text };
	}

	async replayCalls() {
		const [first, second] = await Promise.all([
			this.ctx.storage.get<Array<string>>("replay-first"),
			this.ctx.storage.get<Array<string>>("replay-second"),
		]);
		return { first: first ?? [], second: second ?? [] };
	}

	seedCodeMode() {
		return this.#codeMode.seed();
	}

	readonly #codeModeAbort = new AbortController();

	interruptCodeMode() {
		this.#codeModeAbort.abort();
	}

	async runCodeMode(id: string, source: string, cancellable = false, failActivity = false) {
		const exit = await Effect.runPromiseExit(
			this.#codeMode
				.run(id, source, {
					...(failActivity && {
						onActivity: (event) =>
							event.status === "completed"
								? Effect.fail(codeModeError("Fixture activity error"))
								: Effect.void,
					}),
				})
				.pipe(
					Effect.match({
						onFailure: ({ message }) => ({ error: message }),
						onSuccess: (value) => ({ value }),
					}),
				),
			cancellable ? { signal: this.#codeModeAbort.signal } : undefined,
		);
		return Exit.isSuccess(exit)
			? exit.value
			: { error: codeModeError(Cause.squash(exit.cause)).message };
	}

	codeModeState() {
		return { instance: this.#instance, ...this.#codeMode.state() };
	}

	async seedGitPathLinks() {
		const { fs } = this.#workspace;
		await fs.mkdir("/workspace/repo", { recursive: true });
		await fs.mkdir("/workspace/linked-metadata", { recursive: true });
		await fs.symlink("repo", "/workspace/linked-dir");
		await fs.symlink("../repo/.git", "/workspace/linked-metadata/.git");
	}

	workspaceTool(name: string, input: Schema.Json, recovering = false): Promise<string> {
		const runId = crypto.randomUUID();
		const { catalog, instructions } = workspaceToolset(this.#workspace);
		const tools = createChatExec(this.env.LOADER, this.ctx.storage, {
			catalog: {
				...catalog,
				"codemode:tools": { ...catalog["codemode:tools"], ...this.#scheduleTools },
			},
			instructions: `${instructions}\n${scheduleInstructions}`,
		});
		return Effect.runPromise(
			tools.service
				.execute(
					{ role: "tool-call", id: "test-call", name, input },
					{ runId, idempotencyKey: runId, recovering },
					() => Effect.void,
				)
				.pipe(
					Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ToolResult))),
					Effect.ensuring(Effect.sync(() => tools.settleRun(runId, "completed"))),
				),
		);
	}

	async #pauseAt(point: PausePoint, signal: AbortSignal, executionId?: string) {
		if ((await this.ctx.storage.get("pause")) !== point) {
			return;
		}
		await this.ctx.storage.put({
			pausedAt: point,
			pausedInstance: this.#instance,
			...(executionId !== undefined && { executionId }),
		});
		while ((await this.ctx.storage.get("pause")) === point) {
			signal.throwIfAborted();
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});
		}
	}

	pause(point: PausePoint) {
		if (
			point === "during-replay-write" ||
			point === "during-replay-edit" ||
			point === "during-replay-delete" ||
			point === "during-replay-git" ||
			point === "during-replay-schedule" ||
			point === "reject-atomic-write"
		) {
			this.#atomicFault = point;
			return Promise.resolve();
		}
		return this.ctx.storage.put("pause", point);
	}

	release() {
		return this.ctx.storage.delete("pause");
	}

	discardExecution(runId: string) {
		clearCodeModeRun(this.ctx.storage, runId);
	}

	crash() {
		this.ctx.abort(chatFixtureReset);
	}
}
