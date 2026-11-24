import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import {
	TurnIoError,
	ToolResult,
	TurnModel,
	TurnModelError,
	TurnTools,
} from "@trajan/effect-harness";
import type { TurnMessage, TurnModelEvent } from "@trajan/effect-harness";
import { Effect, Layer, Predicate, Schema, Stream } from "effect";
import { toolActivityKey } from "../effect-harness/tool-activity";
import { EffectHarnessObject } from "../effect-harness/worker-host";
import { effectWorkspaceTools } from "../effect-harness/workspace-tools";
import { createObservedToolBindings, createTrajanWorkspace } from "../workspace";

const effectHarnessReset = "Forced Effect harness fixture restart";
type PausePoint =
	| "before-task"
	| "after-write"
	| "between-tools"
	| "during-reply"
	| "after-commit"
	| "during-replay-read";
const workspaceFile = "/workspace/turn.txt";
const replayPrompt = "Replay two reads.";
const replayCall = "exec-replay";
export function appendExecInput(text: string) {
	return {
		code: `
import fs from "node:fs/promises";
export default async function () {
  await fs.mkdir("/workspace", { recursive: true });
  const path = ${JSON.stringify(workspaceFile)};
  const previous = await fs.readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const content = previous + ${JSON.stringify(text)};
  await fs.writeFile(path, content);
  return content;
}
`,
	};
}

function isMissing(error: unknown): boolean {
	return Predicate.hasProperty(error, "code") && error.code === "ENOENT";
}

export class EffectHarnessTestObject extends EffectHarnessObject {
	readonly #instance = crypto.randomUUID();
	readonly #computer = createTrajanWorkspace(this.ctx.storage, this.env.LOADER);
	readonly #effectTools = effectWorkspaceTools(this.#computer, this.ctx.storage);
	#replayTools: ReturnType<typeof effectWorkspaceTools> | undefined;
	protected override readonly toolCatalog = [this.#effectTools.declaration];

	#createReplayTools() {
		const storage = this.ctx.storage;
		const tools = createObservedToolBindings(() =>
			(["first", "second"] as const).map((name) => ({
				name: `read_${name}`,
				readOnly: true,
				call: async (_input, { callId, signal }) => {
					const key = `replay-${name}`;
					const calls = (await storage.get<Array<string>>(key)) ?? [];
					// Store probe receipts in the host so the test can compare both attempts.
					await storage.put(key, [...calls, callId]);
					if (name === "second") {
						await this.#pauseAt("during-replay-read", signal);
					}
					return { text: name, isError: false };
				},
			})),
		);
		const workspace = new Workspace({
			storage,
			backends: [
				new CodemodeBackend({
					id: "fixture-replay",
					loader: this.env.LOADER,
					root: "/workspace",
					access: "read",
					onInterrupt: "replay",
					modules: { "codemode:tools": tools.module },
				}),
			],
		});
		return effectWorkspaceTools(
			{
				workspace,
				instructions: "Read-only replay fixture.",
				observeExecution: tools.observeExecution,
			},
			storage,
		);
	}

	readonly #execute = Effect.fn("effect-harness.fixture.executeTool")(function* (
		this: EffectHarnessTestObject,
		...args: Parameters<TurnTools["Service"]["execute"]>
	) {
		const [call, attempt] = args;
		if (call.id === "exec-interrupt") {
			yield* Effect.promise(() => this.ctx.storage.put("executionId", attempt.idempotencyKey));
		}
		const tools =
			call.id === replayCall
				? (this.#replayTools ??= this.#createReplayTools())
				: this.#effectTools;
		const result = yield* tools.service.execute(...args);
		if (result.status === "completed") {
			// Pause after Computer settles while the turn's checkpoint is still open.
			yield* Effect.tryPromise({
				try: (signal) => this.#pauseAt("after-write", signal, attempt.idempotencyKey),
				catch: (cause) => new TurnIoError({ operation: call.name, cause }),
			});
		}
		return result;
	});

	readonly #fakeComplete = Effect.fnUntraced(function* (
		this: EffectHarnessTestObject,
		messages: Parameters<TurnModel["Service"]["stream"]>[0],
	): Effect.fn.Return<typeof TurnMessage.Type, TurnModelError> {
		const user = messages.findLast((message) => message.role === "user");
		const last = messages.at(-1);
		const appendTwice = user?.text === "Append hello, then world.";
		if (last?.role === "user" && last.text === "Fail this turn.") {
			return yield* new TurnModelError({
				message: "The fixture model failed.",
			});
		}
		if (last?.role === "user" && last.text.startsWith("Remember ")) {
			return { role: "assistant", text: `Remembering ${last.text.slice("Remember ".length)}` };
		}
		if (last?.role === "user" && last.text === replayPrompt) {
			return {
				role: "tool-call",
				id: replayCall,
				name: "exec",
				input: {
					code: `import { read_first, read_second } from "codemode:tools";
import { writeFile } from "node:fs/promises";
export default async function () {
  const first = await read_first({});
  const second = await read_second({});
  const writeBlocked = await writeFile("/workspace/turn.txt", "blocked").then(
    () => false,
    (error) => String(error).includes("Workspace code write access is not available"),
  );
  if (first.isError || second.isError || !writeBlocked) throw new Error("Unexpected replay result");
  return [first.text, second.text];
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
					code: `import { readFile } from "node:fs/promises";
import { write } from "codemode:tools";
export default async function () {
  const path = ${JSON.stringify(workspaceFile)};
  const previous = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const result = await write({ path, content: previous + "once" });
  if (result.isError) throw new Error(result.text);
  await new Promise((resolve) => setTimeout(resolve, 45_000));
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
			const verb = user?.text === replayPrompt ? "Read" : "Wrote";
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
				stream: (messages) =>
					Stream.unwrap(
						Effect.map(this.#fakeComplete(messages), (response) => {
							const end = Stream.succeed<TurnModelEvent>({ type: "response", response });
							if (response.role !== "assistant") {
								return end;
							}
							const excerpt = response.text.slice(0, 5);
							return Stream.succeed<TurnModelEvent>({ type: "text-delta", text: excerpt }).pipe(
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
					),
			}),
		),
		Layer.succeed(TurnTools, TurnTools.of({ execute: (...args) => this.#execute(...args) })),
	);

	protected override onTurnPhase(phase: "before-task" | "after-commit", signal: AbortSignal) {
		return this.#pauseAt(phase, signal);
	}

	onRequest(request: Request) {
		return this.chatRequest(request);
	}

	async state() {
		const executionId = await this.ctx.storage.get<string>("executionId");
		const pausedAt = await this.ctx.storage.get<PausePoint>("pausedAt");
		const text = await this.#computer.workspace.fs
			.readFile(workspaceFile, "utf8")
			.catch((error: unknown) => {
				if (isMissing(error)) {
					return "";
				}
				throw error;
			});
		return { instance: this.#instance, executionId, pausedAt, text };
	}

	async replayCalls() {
		const [first, second] = await Promise.all([
			this.ctx.storage.get<Array<string>>("replay-first"),
			this.ctx.storage.get<Array<string>>("replay-second"),
		]);
		return { first: first ?? [], second: second ?? [] };
	}

	workspaceTool(name: string, input: Schema.Json, recovering = false): Promise<string> {
		const runId = crypto.randomUUID();
		return Effect.runPromise(
			this.#effectTools.service
				.execute(
					{ role: "tool-call", id: "test-call", name, input },
					{ runId, idempotencyKey: runId, recovering },
					() => Effect.void,
				)
				.pipe(
					Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ToolResult))),
					Effect.ensuring(Effect.sync(() => this.ctx.storage.kv.delete(toolActivityKey(runId)))),
				),
		);
	}

	async #pauseAt(point: PausePoint, signal: AbortSignal, executionId?: string) {
		if ((await this.ctx.storage.get("pause")) !== point) {
			return;
		}
		await this.ctx.storage.put({
			pausedAt: point,
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
		return this.ctx.storage.put("pause", point);
	}

	release() {
		return this.ctx.storage.delete("pause");
	}

	discardExecution(id: string) {
		return this.#computer.workspace.runtime.disposeExec(id);
	}

	async executionStatus(id: string) {
		using handle = await this.#computer.workspace.runtime.getExec(id);
		return (await handle.result()).status;
	}

	crash() {
		this.ctx.abort(effectHarnessReset);
	}
}
