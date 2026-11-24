import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import {
	TurnIoError,
	ToolResult,
	TurnMessage,
	TurnModel,
	TurnModelError,
	TurnTools,
	TurnTranscript,
} from "@trajan/effect-harness";
import type { StepAttempt } from "@trajan/effect-harness";
import { Context, Effect, Layer, Option, Predicate, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { HistoryQuery } from "../effect-harness/conversation-store";
import { EffectHarnessObject } from "../effect-harness/worker-host";
import { workersAiTurnModel } from "../effect-harness/workers-ai";

const effectHarnessReset = "Forced Effect harness fixture restart";
type PausePoint = "before-task" | "after-write" | "between-tools" | "after-commit";
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

const transcriptJson = Schema.fromJsonString(TurnTranscript);
const messageJson = Schema.fromJsonString(TurnMessage);

function isMissing(error: unknown): boolean {
	return Predicate.hasProperty(error, "code") && error.code === "ENOENT";
}

export class EffectHarnessTestObject extends EffectHarnessObject {
	readonly #instance = crypto.randomUUID();
	readonly #workspace = new Workspace({
		storage: this.ctx.storage,
		backends: [new CodemodeBackend({ loader: this.env.LOADER })],
	});
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
		Effect.gen(function* () {
			const toolkit = yield* AppendToolkit;
			return TurnTools.of({
				execute: Effect.fn("effect-harness.fixture.executeTool")(function* (call, attempt) {
					if (call.name !== Append.name) {
						return { status: "failed", message: "Unknown fixture tool" };
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
		messages: Parameters<TurnModel["Service"]["complete"]>[0],
	): Effect.fn.Return<unknown, TurnModelError> {
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
		if (last?.role === "tool") {
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
			this.env.EFFECT_HARNESS_AI
				? workersAiTurnModel(this.env.EFFECT_HARNESS_AI, {
						name: Append.name,
						description: appendDescription,
						parameters: Tool.getJsonSchema(Append),
					})
				: TurnModel.of({ complete: (messages) => this.#fakeComplete(messages) }),
		),
		this.#toolsLayer,
	);

	protected override onTurnPhase(phase: "before-task" | "after-commit", signal: AbortSignal) {
		return this.#pauseAt(phase, signal);
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

/** The development-only Worker exposes completed turns for a real-model smoke test. */
export async function serveEffectHarness(request: Request, env: Env) {
	const url = new URL(request.url);
	if (url.pathname !== "/__effect-harness/turns" && url.pathname !== "/__effect-harness/history") {
		return new Response("Not found", { status: 404 });
	}
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== url.origin) {
		return new Response("Forbidden", { status: 403 });
	}

	const stub = env.EFFECT_HARNESS_TEST.getByName("live-model");
	if (url.pathname === "/__effect-harness/history") {
		if (request.method !== "GET") {
			return new Response(null, { status: 405, headers: { Allow: "GET" } });
		}
		const before = url.searchParams.get("before");
		const limit = url.searchParams.get("limit");
		const query = Schema.decodeOption(HistoryQuery)({
			...(before !== null && { before: Number(before) }),
			...(limit !== null && { limit: Number(limit) }),
		});
		if (query._tag === "None") {
			return Response.json({ error: "Invalid history cursor or limit." }, { status: 400 });
		}
		const { entries, nextBefore } = await stub.history(query.value);
		return Response.json({
			entries: entries.map((entry) => ({
				...entry,
				message: Schema.decodeSync(messageJson)(entry.message),
			})),
			nextBefore,
		});
	}

	if (request.method === "POST") {
		let submission: unknown;
		try {
			submission = await request.json();
		} catch {
			return Response.json({ error: "Expected a JSON submission." }, { status: 400 });
		}
		const receipt = await stub.submit(submission);
		return Response.json(receipt, { status: receipt.runId === null ? 400 : 202 });
	}

	if (request.method === "GET") {
		const runId = url.searchParams.get("runId");
		if (!runId) {
			return Response.json({ error: "Expected a runId." }, { status: 400 });
		}
		const { transcript, ...turn } = await stub.turn(runId);
		return Response.json(
			{
				...turn,
				transcript: transcript === null ? null : Schema.decodeSync(transcriptJson)(transcript),
			},
			{ status: turn.state === "missing" ? 404 : 200 },
		);
	}

	return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
}
