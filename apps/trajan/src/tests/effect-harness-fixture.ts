import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import {
	runTurn,
	TurnIoError,
	type TurnJournal,
	TurnModel,
	TurnSubmission,
	TurnTools,
	TurnTranscript,
} from "@trajan/effect-harness";
import { Lifecycle } from "agents/lifecycle";
import { Tasks, type TaskStep } from "agents/tasks";
import { Effect, Schema } from "effect";

const effectHarnessReset = "Forced Effect harness fixture restart";
const workspaceFile = "/workspace/turn.txt";
const toolName = "append";

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

function taskJournal(step: TaskStep): TurnJournal {
	return {
		checkpoint(name, result, run) {
			const checkpointJson = Schema.fromJsonString(result);
			return Effect.tryPromise({
				try: () =>
					step.do(name, { retries: { limit: 1 } }, ({ attempt, idempotencyKey, signal }) =>
						Effect.runPromise(
							run({
								idempotencyKey,
								recovering: step.interrupted?.name === name || attempt > 1,
							}).pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(result)),
								Effect.flatMap(Schema.encodeEffect(checkpointJson)),
							),
							{ signal },
						),
					),
				catch: (cause) => new TurnIoError({ operation: name, cause }),
			}).pipe(Effect.flatMap(Schema.decodeEffect(checkpointJson)));
		},
	};
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const fakeModel = TurnModel.of({
	complete: (messages) =>
		Effect.sync(() => {
			const last = messages.at(-1);
			if (last?.role === "tool") {
				const { result } = last;
				return {
					role: "assistant",
					text:
						result.status === "completed"
							? `Wrote ${JSON.stringify(result.output)}`
							: result.message,
				};
			}
			return {
				role: "tool-call",
				id: "append-1",
				name: toolName,
				input: last?.role === "user" && last.text,
			};
		}),
});

export class EffectHarnessTestObject extends DurableObject<Env> {
	readonly #instance = crypto.randomUUID();
	readonly #workspace = new Workspace({
		storage: this.ctx.storage,
		backends: [new CodemodeBackend({ loader: this.env.LOADER })],
	});
	readonly #tools = TurnTools.of({
		execute: ({ input, name }, { idempotencyKey, recovering }) =>
			Effect.gen({ self: this }, function* () {
				if (name !== toolName) {
					return { status: "failed", message: "Unknown fixture tool" };
				}
				const text = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(input);
				return yield* Effect.tryPromise({
					try: async (signal) => {
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
							if (await this.ctx.storage.get("pause")) {
								await this.ctx.storage.put("executionId", idempotencyKey);
								while (await this.ctx.storage.get("pause")) {
									signal.throwIfAborted();
									await new Promise((resolve) => setTimeout(resolve, 10));
								}
							}
							return { status: "completed", output: result.value ?? null };
						} catch (error) {
							// A pruned execution ID can be started again. Recovery only reattaches.
							if (recovering && isMissing(error)) {
								return { status: "unknown", message: "The previous tool outcome is unknown." };
							}
							throw error;
						}
					},
					catch: (cause) => new TurnIoError({ operation: name, cause }),
				});
			}),
	});
	readonly #tasks = new Tasks({
		definitions: {
			"turn@v1": (input: typeof TurnSubmission.Type, step: TaskStep) =>
				Effect.runPromise(
					runTurn(input, taskJournal(step)).pipe(
						Effect.provideService(TurnModel, fakeModel),
						Effect.provideService(TurnTools, this.#tools),
						Effect.flatMap(Schema.encodeEffect(transcriptJson)),
					),
				),
		},
	});
	readonly lifecycle = Lifecycle.install(this).use(this.#tasks);

	submit(input: unknown) {
		return Effect.runPromise(
			Schema.decodeUnknownEffect(TurnSubmission)(input).pipe(
				Effect.flatMap((submission) =>
					Effect.tryPromise({
						try: () => this.#tasks.run("turn@v1", submission, { idempotencyKey: submission.id }),
						catch: (cause) => new TurnIoError({ operation: "submit", cause }),
					}),
				),
				Effect.catchTag("SchemaError", (error) =>
					Effect.succeed({ accepted: false, runId: null, error: error.message }),
				),
			),
		);
	}

	async turn(runId: string) {
		const run = await this.#tasks.handle("turn@v1").get(runId);
		return {
			state: run?.state ?? "missing",
			transcript: run?.state === "completed" ? run.result : null,
			error: run?.state === "failed" ? run.error.message : null,
		};
	}

	async state() {
		const executionId = await this.ctx.storage.get<string>("executionId");
		const text = await this.#workspace.fs
			.readFile(workspaceFile, "utf8")
			.catch((error: unknown) => {
				if (isMissing(error)) return "";
				throw error;
			});
		return { instance: this.#instance, executionId, text };
	}

	pause() {
		return this.ctx.storage.put("pause", true);
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
