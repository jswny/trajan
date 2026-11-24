import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import {
	runTurn,
	TurnIoError,
	type TurnJournal,
	TurnMessage,
	TurnModel,
	TurnSubmission,
	TurnTools,
	TurnTranscript,
} from "@trajan/effect-harness";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { Tasks, type TaskStep } from "agents/tasks";
import { Effect, Schema } from "effect";
import { ConversationStore, HistoryQuery } from "../effect-harness/conversation-store";
import { workersAiTurnModel } from "../effect-harness/workers-ai";

const effectHarnessReset = "Forced Effect harness fixture restart";
const turnDefinition = "turn@v3";
const inboxJob = "effect-harness-inbox";
type PausePoint = "before-task" | "after-write" | "between-tools" | "after-commit";
const workspaceFile = "/workspace/turn.txt";
const appendInput = Schema.Struct({ text: Schema.NonEmptyString });
const appendTool = {
	name: "append",
	description: "Append text to the fixture workspace file and return its full contents.",
	parameters: Schema.toJsonSchemaDocument(appendInput).schema,
};

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

function conversationEffect<A>(operation: string, run: () => A) {
	return Effect.try({ try: run, catch: (cause) => new TurnIoError({ operation, cause }) });
}

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
				catch: (cause) =>
					cause instanceof TurnIoError ? cause : new TurnIoError({ operation: name, cause }),
			}).pipe(Effect.flatMap(Schema.decodeEffect(checkpointJson)));
		},
	};
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export class EffectHarnessTestObject extends DurableObject<Env> {
	readonly #instance = crypto.randomUUID();
	readonly #conversation = new ConversationStore(this.ctx.storage);
	readonly #workspace = new Workspace({
		storage: this.ctx.storage,
		backends: [new CodemodeBackend({ loader: this.env.LOADER })],
	});
	readonly #tools = TurnTools.of({
		execute: ({ input, name }, { idempotencyKey, recovering }) =>
			Effect.gen({ self: this }, function* () {
				if (name !== appendTool.name) {
					return { status: "failed", message: "Unknown fixture tool" };
				}
				const { text } = yield* Schema.decodeUnknownEffect(appendInput)(input);
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
					catch: (cause) => new TurnIoError({ operation: name, cause }),
				});
			}),
	});
	readonly #fakeModel = TurnModel.of({
		complete: (messages) =>
			Effect.gen({ self: this }, function* () {
				const user = messages.findLast((message) => message.role === "user");
				const last = messages.at(-1);
				const appendTwice = user?.text === "Append hello, then world.";
				if (last?.role === "user" && last.text === "Fail this turn.") {
					return yield* new TurnIoError({
						operation: "fixture model",
						cause: null,
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
							memory?.role === "assistant"
								? memory.text.slice("Remembering ".length)
								: "I don't know.",
					};
				}
				if (last?.role === "tool") {
					if (appendTwice && last.callId === "append-1") {
						yield* Effect.tryPromise({
							try: (signal) => this.#pauseAt("between-tools", signal),
							catch: (cause) => new TurnIoError({ operation: "pause between tools", cause }),
						});
						return {
							role: "tool-call",
							id: "append-2",
							name: appendTool.name,
							input: { text: " world" },
						};
					}
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
					name: appendTool.name,
					input: { text: appendTwice ? "hello" : (user?.text ?? "") },
				};
			}),
	});
	readonly #model = this.env.EFFECT_HARNESS_AI
		? workersAiTurnModel(this.env.EFFECT_HARNESS_AI, appendTool)
		: this.#fakeModel;
	readonly #tasks = new Tasks({
		onError: () => this.#wakeInbox(),
		definitions: {
			[turnDefinition]: ({ runId }: { runId: string }, step: TaskStep) =>
				Effect.runPromise(
					this.#runSubmission(runId, step).pipe(
						Effect.provideService(TurnModel, this.#model),
						Effect.provideService(TurnTools, this.#tools),
					),
				),
		},
	});
	readonly lifecycle = Lifecycle.install(this).use(this.#tasks);

	async onStart() {
		this.#conversation.initialize();
		if (this.#conversation.head() && !this.lifecycle.jobs.get(inboxJob)) {
			await this.#wakeInbox();
		}
	}

	async #wakeInbox() {
		await this.lifecycle.jobs.push({ id: inboxJob, fn: inboxJob, time: Date.now() });
	}

	async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
		if (job.fn !== inboxJob) return;
		return Effect.runPromise(
			Effect.tryPromise({
				try: async (signal) => {
					const head = this.#conversation.head();
					if (!head) return undefined;

					const runId = head.run_id;
					const task = await this.#tasks.handle(turnDefinition).get(runId);
					if (!task) {
						await this.#pauseAt("before-task", signal);
						await this.#tasks.run(turnDefinition, { runId }, { runId });
					} else if (
						task.state === "failed" ||
						task.state === "cancelled" ||
						task.state === "completed"
					) {
						// A settled task can only leave a pending row when it could not commit the turn.
						const message =
							task.state === "failed" ? task.error.message : "The turn ended without a transcript.";
						this.#conversation.fail(runId, message);
						return "yield" as const;
					}
					// A task that terminates before committing may never signal the inbox.
					return { rescheduleAt: Date.now() + 30_000 };
				},
				catch: (cause) => new TurnIoError({ operation: "drain inbox", cause }),
			}),
		);
	}

	#runSubmission(runId: string, step: TaskStep) {
		return Effect.gen({ self: this }, function* () {
			const row = yield* conversationEffect("start turn", () => this.#conversation.start(runId));
			if (row.state === "completed" || row.state === "failed") return;
			const through = row.context_through;
			if (through === null) {
				return yield* new TurnIoError({
					operation: "read context",
					cause: null,
					message: "The turn has no context cursor.",
				});
			}
			const context = yield* conversationEffect("read context", () =>
				this.#conversation.context(through),
			);
			const transcript = yield* runTurn(
				{ id: row.submission_id, prompt: row.prompt },
				taskJournal(step),
				context,
			);

			yield* conversationEffect("commit turn", () => this.#conversation.commit(runId, transcript));
			yield* Effect.tryPromise({
				try: async (signal) => {
					await this.#pauseAt("after-commit", signal);
					await this.#wakeInbox();
				},
				catch: (cause) => new TurnIoError({ operation: "wake inbox", cause }),
			});
		});
	}

	submit(input: unknown) {
		return Effect.runPromise(
			Schema.decodeUnknownEffect(TurnSubmission)(input).pipe(
				Effect.flatMap((submission) =>
					Effect.tryPromise({
						try: async () => {
							await this.lifecycle.start();
							return this.ctx.blockConcurrencyWhile(async () => {
								// Arm the durable wake first. The input gate keeps it from draining
								// before this submission is committed.
								await this.#wakeInbox();
								return this.#conversation.admit(submission);
							});
						},
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
		await this.lifecycle.start();
		return this.#conversation.turn(runId);
	}

	async history(query: typeof HistoryQuery.Type) {
		await this.lifecycle.start();
		return this.#conversation.history(query);
	}

	async taskState(runId: string) {
		return (await this.#tasks.handle(turnDefinition).get(runId))?.state ?? "missing";
	}

	async state() {
		const executionId = await this.ctx.storage.get<string>("executionId");
		const pausedAt = await this.ctx.storage.get<PausePoint>("pausedAt");
		const text = await this.#workspace.fs
			.readFile(workspaceFile, "utf8")
			.catch((error: unknown) => {
				if (isMissing(error)) return "";
				throw error;
			});
		return { instance: this.#instance, executionId, pausedAt, text };
	}

	async #pauseAt(point: PausePoint, signal: AbortSignal, executionId?: string) {
		if ((await this.ctx.storage.get("pause")) !== point) return;
		await this.ctx.storage.put({
			pausedAt: point,
			...(executionId === undefined ? {} : { executionId }),
		});
		while ((await this.ctx.storage.get("pause")) === point) {
			signal.throwIfAborted();
			await new Promise((resolve) => setTimeout(resolve, 10));
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
		if (request.method !== "GET")
			return new Response(null, { status: 405, headers: { Allow: "GET" } });
		const before = url.searchParams.get("before");
		const limit = url.searchParams.get("limit");
		const query = Schema.decodeUnknownOption(HistoryQuery)({
			...(before === null ? {} : { before: Number(before) }),
			...(limit === null ? {} : { limit: Number(limit) }),
		});
		if (query._tag === "None")
			return Response.json({ error: "Invalid history cursor or limit." }, { status: 400 });
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
		if (!runId) return Response.json({ error: "Expected a runId." }, { status: 400 });
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
