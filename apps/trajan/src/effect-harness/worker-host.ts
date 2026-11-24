import { DurableObject } from "cloudflare:workers";
import { runTurn, TurnIoError, TurnModelError, TurnSubmission } from "@trajan/effect-harness";
import type { TurnJournal, TurnModel, TurnProgress, TurnTools } from "@trajan/effect-harness";
import { Lifecycle } from "agents/lifecycle";
import type { LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { WebSockets } from "agents/websockets";
import { Clock, Effect, Schema } from "effect";
import type { Layer } from "effect";
import { ChatEvent, ChatHistoryQuery, ChatPath, ChatStop } from "./chat-protocol";
import type { ChatPreview, ChatSnapshot, ChatToolInfo } from "./chat-protocol";
import { ConversationStore } from "./conversation-store";
import type { HistoryQuery } from "./conversation-store";

const turnDefinition = "turn@v3";
const inboxJob = "effect-harness-inbox";
const TurnTaskInput = Schema.Struct({ runId: Schema.NonEmptyString });
const chatEventJson = Schema.encodeSync(Schema.fromJsonString(ChatEvent));
const chatTag = "chat";
const decodeSubmission = Schema.decodeUnknownOption(TurnSubmission);
const decodeHistory = Schema.decodeUnknownOption(ChatHistoryQuery);
const decodeStop = Schema.decodeUnknownOption(ChatStop);

function sendChat(socket: WebSocket, data: string) {
	if (socket.readyState === 1) {
		try {
			socket.send(data);
		} catch {
			// A disconnected observer cannot affect the durable turn.
		}
	}
}

class TurnTaskInputError extends Schema.TaggedError<
	TurnTaskInputError,
	{ readonly brand: unique symbol }
>()("TurnTaskInputError", {
	message: Schema.String,
}) {}

function conversationEffect<A>(operation: string, run: () => A) {
	return Effect.try({ try: run, catch: (cause) => new TurnIoError({ operation, cause }) });
}

function failureCode(name: string) {
	switch (name) {
		case "TurnModelError":
			return "model";
		case "TurnTaskInputError":
			return "task-input";
		case "SchemaError":
			return "schema";
		default:
			return "execution";
	}
}

function taskJournal(runId: string, step: TaskStep): TurnJournal {
	return {
		checkpoint(name, result, run) {
			const checkpointJson = Schema.fromJsonString(result);
			return Effect.gen(function* () {
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
				return yield* Effect.promise(() =>
					step.do(
						name,
						{
							retries: name.startsWith("model:") ? { limit: 2, delay: "1 second" } : { limit: 1 },
						},
						({ attempt, idempotencyKey, signal }) =>
							runPromise(
								run({
									runId,
									idempotencyKey,
									recovering: step.interrupted?.name === name || attempt > 1,
								}).pipe(
									Effect.flatMap(Schema.decodeUnknownEffect(result)),
									Effect.flatMap(Schema.encodeEffect(checkpointJson)),
									Effect.withSpan("effect-harness.step.attempt", {
										attributes: { runId, name, attempt },
									}),
								),
								{ signal },
							),
					),
				).pipe(
					Effect.catchDefect((error) => {
						if (
							error instanceof TurnModelError ||
							error instanceof TurnIoError ||
							Schema.isSchemaError(error)
						) {
							return Effect.fail(error);
						}
						// Preserve SDK suspension, cancellation, and isolate reset signals.
						return Effect.die(error);
					}),
					Effect.flatMap(Schema.decodeEffect(checkpointJson)),
				);
			}).pipe(Effect.withSpan("effect-harness.checkpoint", { attributes: { runId, name } }));
		},
	};
}

export abstract class EffectHarnessObject extends DurableObject<Env> {
	protected abstract readonly turnLayer: Layer.Layer<TurnModel | TurnTools>;
	protected readonly toolCatalog: ReadonlyArray<typeof ChatToolInfo.Type> = [];

	protected onTurnPhase?(phase: "before-task" | "after-commit", signal: AbortSignal): Promise<void>;

	readonly #conversation = new ConversationStore(this.ctx.storage);
	#draft: typeof ChatPreview.Type | undefined;
	readonly #sockets = new WebSockets({
		protocol: false,
		getConnectionTags: () => [chatTag],
		handlers: {
			onConnect: (socket) => sendChat(socket, chatEventJson(this.#snapshot())),
		},
	});
	readonly #tasks = new Tasks({
		onError: () => Effect.runPromise(this.#wakeInbox()),
		definitions: {
			[turnDefinition]: (input: unknown, step: TaskStep) =>
				Effect.runPromise(
					Schema.decodeUnknownEffect(TurnTaskInput)(input).pipe(
						Effect.mapError(
							() => new TurnTaskInputError({ message: "Invalid persisted turn task input." }),
						),
						Effect.flatMap(({ runId }) => this.#runSubmission(runId, step)),
						Effect.provide(this.turnLayer),
					),
				),
		},
	});
	readonly lifecycle = Lifecycle.install(this).use(this.#sockets).use(this.#tasks);

	onStart() {
		this.#conversation.initialize();
		this.#broadcastSnapshot();
		if (this.#conversation.head() && !this.lifecycle.jobs.get(inboxJob)) {
			return Effect.runPromise(this.#wakeInbox());
		}
	}

	#wakeInbox = Effect.fnUntraced(function* (this: EffectHarnessObject) {
		const time = yield* Clock.currentTimeMillis;
		yield* Effect.promise(() => this.lifecycle.jobs.push({ id: inboxJob, fn: inboxJob, time }));
	});

	onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> | undefined {
		if (job.fn === inboxJob) {
			return Effect.runPromise(this.#drainInbox());
		}
	}

	#drainInbox = Effect.fn("effect-harness.drainInbox")(function* (this: EffectHarnessObject) {
		const head = yield* conversationEffect("read inbox", () => this.#conversation.head());
		if (!head) {
			return;
		}
		const runId = head.run_id;
		yield* Effect.annotateCurrentSpan("runId", runId);
		const task = yield* Effect.promise(() => this.#tasks.handle(turnDefinition).get(runId));
		if (head.state === "stopping") {
			if (
				task &&
				task.state !== "failed" &&
				task.state !== "cancelled" &&
				task.state !== "completed"
			) {
				yield* Effect.promise(() => this.#tasks.handle(turnDefinition).cancel(runId));
				return { rescheduleAt: (yield* Clock.currentTimeMillis) + 250 };
			}
			yield* conversationEffect("cancel turn", () => this.#conversation.cancel(runId));
			yield* this.#settleDraft(runId);
			return "yield" as const;
		}
		if (!task) {
			yield* Effect.promise(async (signal) => {
				await this.onTurnPhase?.("before-task", signal);
				await this.#tasks.run(turnDefinition, { runId }, { runId });
			});
		} else if (
			task.state === "failed" ||
			task.state === "cancelled" ||
			task.state === "completed"
		) {
			// A settled task can only leave a pending row when it could not commit the turn.
			const message =
				task.state === "failed" ? task.error.message : "The turn ended without a transcript.";
			const code = task.state === "failed" ? failureCode(task.error.name) : task.state;
			yield* conversationEffect("fail turn", () => this.#conversation.fail(runId, message));
			yield* this.#settleDraft(runId);
			yield* Effect.logWarning("Effect harness turn ended without a transcript").pipe(
				Effect.annotateLogs({ runId, code }),
			);
			return "yield" as const;
		}
		// A task that terminates before committing may never signal the inbox.
		return { rescheduleAt: (yield* Clock.currentTimeMillis) + 30_000 };
	});

	#runSubmission = Effect.fn("effect-harness.runSubmission")(function* (
		this: EffectHarnessObject,
		runId: string,
		step: TaskStep,
	) {
		yield* Effect.annotateCurrentSpan("runId", runId);
		const row = yield* conversationEffect("start turn", () => this.#conversation.start(runId));
		if (row.state !== "running") {
			return;
		}
		yield* Effect.sync(() => this.#broadcastSnapshot());
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
			taskJournal(runId, step),
			context,
			(event) => this.#publishProgress(runId, event),
		);

		yield* conversationEffect("commit turn", () => this.#conversation.commit(runId, transcript));
		yield* this.#settleDraft(runId);
		yield* Effect.promise(async (signal) => this.onTurnPhase?.("after-commit", signal));
		yield* this.#wakeInbox();
	});

	#publishProgress(runId: string, event: TurnProgress) {
		return Effect.sync(() => {
			switch (event.type) {
				case "reset":
				case "tool": {
					const tool = event.type === "tool" ? event.name : null;
					this.#draft = { runId, text: "", tool, activity: [] };
					this.#broadcast({ type: "preview", ...this.#draft });
					break;
				}
				case "tool-activity":
					if (this.#draft?.runId === runId && this.#draft.tool !== null) {
						this.#draft = { ...this.#draft, activity: event.activity };
						this.#broadcast({ type: "preview", ...this.#draft });
					}
					break;
				case "text-delta":
					if (this.#draft?.runId === runId) {
						this.#draft = { ...this.#draft, text: this.#draft.text + event.text };
						this.#broadcast({ ...event, runId });
					}
					break;
			}
		});
	}

	#snapshot(): typeof ChatSnapshot.Type {
		const { active, queued } = this.#conversation.chatStatus();
		const draft = this.#draft;
		return {
			type: "snapshot",
			page: this.#conversation.chatPage({}),
			active,
			queued,
			preview: draft && draft.runId === active?.runId ? draft : null,
			catalog: this.toolCatalog,
		};
	}

	#broadcast(event: typeof ChatEvent.Type) {
		const sockets = this.ctx.getWebSockets(chatTag);
		if (sockets.length > 0) {
			const data = chatEventJson(event);
			for (const socket of sockets) {
				sendChat(socket, data);
			}
		}
	}

	#broadcastSnapshot() {
		if (this.ctx.getWebSockets(chatTag).length > 0) {
			this.#broadcast(this.#snapshot());
		}
	}

	#settleDraft(runId: string) {
		return Effect.sync(() => {
			if (this.#draft?.runId === runId) {
				this.#draft = undefined;
			}
			this.#broadcastSnapshot();
		});
	}

	submit(input: unknown) {
		return Effect.runPromise(
			Schema.decodeUnknownEffect(TurnSubmission)(input).pipe(
				Effect.flatMap((submission) =>
					Effect.promise(async () => {
						await this.lifecycle.start();
						return this.ctx.blockConcurrencyWhile(async () => {
							// Arm the durable wake before committing the submission under the input gate.
							await Effect.runPromise(this.#wakeInbox());
							const receipt = this.#conversation.admit(submission);
							if (receipt.accepted) {
								this.#broadcastSnapshot();
							}
							return receipt;
						});
					}),
				),
				Effect.catchTag("SchemaError", (error) =>
					Effect.succeed({ accepted: false, runId: null, error: error.message }),
				),
			),
		);
	}

	async stop(runId: string) {
		await this.lifecycle.start();
		return this.ctx.blockConcurrencyWhile(async () => {
			await Effect.runPromise(this.#wakeInbox());
			const stopped = this.#conversation.requestStop(runId);
			if (stopped) {
				this.#broadcastSnapshot();
			}
			return { runId, stopped };
		});
	}

	protected async chatRequest(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === `${ChatPath}/history` && request.method === "GET") {
			const before = url.searchParams.get("before");
			const query = decodeHistory(before === null ? {} : { before: Number(before) });
			if (query._tag === "None") {
				return Response.json({ error: "Invalid history cursor." }, { status: 400 });
			}
			await this.lifecycle.start();
			return Response.json(this.#conversation.chatPage(query.value));
		}
		if (request.method !== "POST") {
			return new Response(null, { status: 404 });
		}
		const body: unknown = await request.json().catch(() => null);
		switch (url.pathname) {
			case ChatPath: {
				const input = decodeSubmission(body);
				if (input._tag === "None") {
					return Response.json(
						{ accepted: false, runId: null, error: "Invalid submission." },
						{ status: 400 },
					);
				}
				const receipt = await this.submit(input.value);
				return Response.json(
					{ submissionId: input.value.id, ...receipt },
					{ status: receipt.runId === null ? 400 : 202 },
				);
			}
			case `${ChatPath}/stop`: {
				const input = decodeStop(body);
				if (input._tag === "None") {
					return Response.json({ error: "Invalid run ID." }, { status: 400 });
				}
				return Response.json(await this.stop(input.value.runId));
			}
			default:
				return new Response(null, { status: 404 });
		}
	}

	async turn(runId: string) {
		await this.lifecycle.start();
		const turn = this.#conversation.turn(runId);
		if (turn.state !== "failed") {
			return { ...turn, failure: null };
		}
		// Tasks already retains the error name. Keep the transcript database's format.
		const task = await this.#tasks.handle(turnDefinition).get(runId);
		const code =
			task?.state === "failed"
				? failureCode(task.error.name)
				: task?.state === "cancelled"
					? "cancelled"
					: "execution";
		return { ...turn, failure: { code, message: turn.error ?? "The turn failed." } };
	}

	async history(query: typeof HistoryQuery.Type) {
		await this.lifecycle.start();
		return this.#conversation.history(query);
	}

	async taskState(runId: string) {
		return (await this.#tasks.handle(turnDefinition).get(runId))?.state ?? "missing";
	}
}
