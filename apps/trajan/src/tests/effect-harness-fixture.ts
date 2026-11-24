import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import {
	TurnIoError,
	ToolResult,
	TurnModel,
	TurnModelError,
	TurnTools,
} from "@trajan/effect-harness";
import type { StepAttempt, TurnMessage, TurnModelEvent } from "@trajan/effect-harness";
import { Context, Effect, Layer, Option, Predicate, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { EffectHarnessObject } from "../effect-harness/worker-host";
import { effectWorkspaceTools } from "../effect-harness/workspace-tools";

const effectHarnessReset = "Forced Effect harness fixture restart";
type PausePoint = "before-task" | "after-write" | "between-tools" | "during-reply" | "after-commit";
const workspaceFile = "/workspace/turn.txt";
class AppendAttempt extends Context.Service<AppendAttempt, StepAttempt>()(
	"trajan/fixture/AppendAttempt",
) {}

const appendDescription = "Append text to the fixture workspace file and return its full contents.";
const Append = Tool.make("append", {
	description: appendDescription,
	parameters: Schema.Struct({ text: Schema.NonEmptyString }),
	success: ToolResult,
	failure: TurnIoError,
	dependencies: [AppendAttempt],
});
const AppendToolkit = Toolkit.make(Append);

const appendScript = `
import fs from "node:fs/promises";
export default async function (text) {
  await fs.mkdir("/workspace", { recursive: true });
  const path = ${JSON.stringify(workspaceFile)};
  const previous = await fs.readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const content = previous + text;
  await fs.writeFile(path, content);
  return content;
}
`;

function isMissing(error: unknown): boolean {
	return Predicate.hasProperty(error, "code") && error.code === "ENOENT";
}

export class EffectHarnessTestObject extends EffectHarnessObject {
	protected override readonly toolCatalog = [{ name: Append.name, description: appendDescription }];
	readonly #instance = crypto.randomUUID();
	readonly #workspace = new Workspace({
		storage: this.ctx.storage,
		backends: [new CodemodeBackend({ loader: this.env.LOADER })],
	});
	readonly #effectTools = effectWorkspaceTools(this.#workspace, () =>
		this.env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString()),
	);
	readonly #append = Effect.fn("effect-harness.fixture.append")(function* (
		this: EffectHarnessTestObject,
		{ text }: { text: string },
	): Effect.fn.Return<typeof ToolResult.Type, TurnIoError, AppendAttempt> {
		const { idempotencyKey, recovering } = yield* AppendAttempt;
		return yield* Effect.tryPromise({
			try: async (signal): Promise<typeof ToolResult.Type> => {
				const runtime = this.#workspace.runtime;
				try {
					using handle = recovering
						? await runtime.getExec(idempotencyKey, { encoding: "utf8" })
						: await runtime.exec(appendScript, {
								id: idempotencyKey,
								input: text,
								onInterrupt: "fail",
								encoding: "utf8",
							});
					const result = await handle.result();
					if (result.status !== "completed") {
						return { status: recovering ? "unknown" : "failed", message: result.stderr };
					}
					// Pause after Computer commits, while the Task's tool checkpoint is still open.
					await this.#pauseAt("after-write", signal, idempotencyKey);
					return { status: "completed", output: result.value ?? null };
				} catch (error) {
					// A pruned execution ID can be started again. Recovery only reattaches.
					if (recovering && isMissing(error)) {
						return { status: "unknown", message: "The previous tool outcome is unknown." };
					}
					throw error;
				}
			},
			catch: (cause) => new TurnIoError({ operation: Append.name, cause }),
		});
	});

	readonly #toolsLayer = Layer.effect(
		TurnTools,
		Effect.gen({ self: this }, function* () {
			const toolkit = yield* AppendToolkit;
			const workspaceTools = this.#effectTools;
			return TurnTools.of({
				execute: Effect.fn("effect-harness.fixture.executeTool")(function* (call, attempt) {
					if (call.name !== Append.name) {
						return yield* workspaceTools.service.execute(call, attempt);
					}
					const result = yield* toolkit.handle(Append.name, call.input, call.id).pipe(
						Effect.flatMap(Stream.runLast),
						Effect.flatMap((last) =>
							Option.isSome(last)
								? Effect.succeed(last.value.result)
								: Effect.fail(
										new TurnIoError({ operation: Append.name, cause: "Missing tool result" }),
									),
						),
						Effect.provideService(AppendAttempt, attempt),
						Effect.catchTag("AiError", (error) =>
							error.reason._tag === "ToolParameterValidationError"
								? Effect.succeed({
										status: "failed" as const,
										message: "Invalid append arguments. Provide a non-empty text string.",
									})
								: Effect.fail(new TurnIoError({ operation: Append.name, cause: error })),
						),
					);
					return result;
				}),
			});
		}),
	).pipe(Layer.provide(AppendToolkit.toLayer({ append: (input) => this.#append(input) })));

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
		if (last?.role === "user" && last.text === "Run a workspace module.") {
			return {
				role: "tool-call",
				id: "codemode-1",
				name: "codemode",
				input: {
					code: 'return await tools.exec({ command: "export default () => 42" })',
				},
			};
		}
		if (last?.role === "user" && last.text === "Fail Code Mode after a write.") {
			return {
				role: "tool-call",
				id: "codemode-1",
				name: "codemode",
				input: {
					code: `await tools.write({ path: ${JSON.stringify(workspaceFile)}, content: "written" });
throw new Error("Script failed after writing.");`,
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
					name: Append.name,
					input: { text: " world" },
				};
			}
			const { result } = last;
			return {
				role: "assistant",
				text:
					result.status === "completed" ? `Wrote ${JSON.stringify(result.output)}` : result.message,
			};
		}
		return {
			role: "tool-call",
			id: "append-1",
			name: Append.name,
			input: {
				text: appendTwice
					? "hello"
					: user?.text === "Call append without text."
						? ""
						: (user?.text ?? ""),
			},
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
		this.#toolsLayer,
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
		const text = await this.#workspace.fs
			.readFile(workspaceFile, "utf8")
			.catch((error: unknown) => {
				if (isMissing(error)) {
					return "";
				}
				throw error;
			});
		return { instance: this.#instance, executionId, pausedAt, text };
	}

	workspaceTool(name: string, input: Schema.Json, recovering = false): Promise<string> {
		return Effect.runPromise(
			this.#effectTools.service
				.execute(
					{ role: "tool-call", id: "test-call", name, input },
					{ idempotencyKey: "test-call", recovering },
				)
				.pipe(Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ToolResult)))),
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
		return this.#workspace.runtime.disposeExec(id);
	}

	crash() {
		this.ctx.abort(effectHarnessReset);
	}
}
