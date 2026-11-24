import { DurableObject } from "cloudflare:workers";
import { runTurn, TurnIoError, TurnModelError, TurnSubmission } from "@trajan/effect-harness";
import type { TurnJournal, TurnModel, TurnProgress, TurnTools } from "@trajan/effect-harness";
import { Lifecycle } from "agents/lifecycle";
import type { LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { Clock, Effect, PubSub, Schema, Stream } from "effect";
import type { Layer } from "effect";
import { Sse } from "effect/encoding";
import { ConversationStore } from "./conversation-store";
import type { HistoryQuery } from "./conversation-store";
import { TurnStreamEvent } from "./turn-events";

const turnDefinition = "turn@v3";
const inboxJob = "effect-harness-inbox";
const TurnTaskInput = Schema.Struct({ runId: Schema.NonEmptyString });
const eventJson = Schema.encodeSync(Schema.fromJsonString(TurnStreamEvent));
type Draft = { text: string; generation: symbol | undefined };

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
					step.do(name, { retries: { limit: 1 } }, ({ attempt, idempotencyKey, signal }) =>
						runPromise(
							run({
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

	protected onTurnPhase?(phase: "before-task" | "after-commit", signal: AbortSignal): Promise<void>;

	readonly #conversation = new ConversationStore(this.ctx.storage);
	readonly #updates = Effect.runSync(PubSub.sliding<void>(1));
	#draft: (Draft & { runId: string }) | undefined;
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
	readonly lifecycle = Lifecycle.install(this).use(this.#tasks);

	onStart() {
		this.#conversation.initialize();
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
		if (row.state === "completed" || row.state === "failed") {
			return;
		}
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
			if (event.type === "reset") {
				this.#draft = { runId, generation: Symbol(), text: "" };
			} else if (this.#draft?.runId === runId) {
				this.#draft.text += event.text;
			}
			PubSub.publishUnsafe(this.#updates, undefined);
		});
	}

	#settleDraft(runId: string) {
		return Effect.sync(() => {
			if (this.#draft?.runId === runId) {
				this.#draft = undefined;
			}
			PubSub.publishUnsafe(this.#updates, undefined);
		});
	}

	protected async streamTurn(runId: string) {
		await this.lifecycle.start();
		const events = Stream.unwrap(
			Effect.map(PubSub.subscribe(this.#updates), (updates) =>
				Stream.fromSubscription(updates).pipe(Stream.prepend([undefined])),
			),
		).pipe(
			// Read the snapshot after subscribing so a concurrent commit can't be missed.
			Stream.mapAccum(
				(): Draft | undefined => undefined,
				(previous, _): readonly [Draft | undefined, ReadonlyArray<typeof TurnStreamEvent.Type>] => {
					const active = this.#draft;
					let draft: Draft = { generation: undefined, text: "" };
					if (active?.runId === runId) {
						draft = { generation: active.generation, text: active.text };
					} else {
						const state = this.#conversation.state(runId);
						if (state !== "pending" && state !== "running") {
							return [undefined, [{ type: "settled", state }]];
						}
					}
					if (!previous || previous.generation !== draft.generation) {
						return [draft, [{ type: "draft", text: draft.text }]];
					}
					const text = draft.text.slice(previous.text.length);
					return [draft, text ? [{ type: "text-delta", text }] : []];
				},
			),
			Stream.takeUntil((event) => event.type === "settled"),
			Stream.map((event) =>
				Sse.encoder.write({
					_tag: "Event",
					event: "message",
					id: undefined,
					data: eventJson(event),
				}),
			),
			Stream.encodeText,
		);
		return new Response(Stream.toReadableStream(events), {
			headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
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
							return this.#conversation.admit(submission);
						});
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
