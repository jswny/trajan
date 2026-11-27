import { DurableObject } from "cloudflare:workers";
import {
	publishUpdate,
	restoreModelContext,
	runTurn,
	TurnIoError,
	TurnModel,
	TurnModelError,
	TurnSubmission,
} from "@trajan/harness";
import type {
	RuntimeOutcome,
	ToolActivity,
	TurnJournal,
	TurnMessage,
	TurnProgress,
	TurnTools,
} from "@trajan/harness";
import { Lifecycle, LifecycleCapability } from "agents/lifecycle";
import type { LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { Clock, Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { ConversationStore } from "./conversation-store";
import type { HistoryQuery } from "./conversation-store";

// Tasks and jobs use these names to look up work persisted by prior isolates.
const turnDefinition = "turn@v3";
const inboxWakeJob = "harness-inbox:wake";
const inboxBackoffKey = "harness-inbox:wake-backoff";
const inboxHeartbeatMs = 30_000;
const maxInboxBackoffMs = 10 * 60_000;
const decodeInboxBackoff = Schema.decodeUnknownOption(Schema.Natural);
const TurnTaskInput = Schema.Struct({ runId: Schema.NonEmptyString });

class TurnTaskInputError extends Schema.TaggedError<
	TurnTaskInputError,
	{ readonly brand: unique symbol }
>()("TurnTaskInputError", {
	message: Schema.String,
}) {}

function conversationEffect<A>(operation: string, run: () => A) {
	return Effect.try({ try: run, catch: (cause) => new TurnIoError({ operation, cause }) });
}

function lifecycleEffect<A>(operation: string, run: () => Promise<A>) {
	return Effect.tryPromise({
		try: run,
		catch: (cause) =>
			cause instanceof TurnIoError ? cause : new TurnIoError({ operation, cause }),
	});
}

class InboxWake extends LifecycleCapability {
	constructor(private readonly drain: () => Effect.Effect<LifecycleJobOutcome, TurnIoError>) {
		super("harness-inbox");
	}

	hasWake() {
		return this.lifecycle.jobs.get(inboxWakeJob) !== undefined;
	}

	readonly wake = Effect.fnUntraced(function* (this: InboxWake) {
		const time = yield* Clock.currentTimeMillis;
		yield* lifecycleEffect("wake inbox", () =>
			this.lifecycle.jobs.push({ id: inboxWakeJob, fn: "wake", time }),
		);
	});

	onJob({ job }: LifecycleJobContext) {
		if (job.id === inboxWakeJob) {
			return Effect.runPromise(
				this.drain().pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							const kv = this.lifecycle.storage.kv;
							if (kv.get(inboxBackoffKey) !== undefined) {
								kv.delete(inboxBackoffKey);
							}
						}),
					),
				),
			);
		}
	}

	onJobError({ job, attempt }: LifecycleJobContext, error: unknown) {
		if (job.id === inboxWakeJob) {
			return Effect.runPromise(
				Effect.gen({ self: this }, function* () {
					const now = yield* Clock.currentTimeMillis;
					const kv = this.lifecycle.storage.kv;
					// Keep backoff outside the job so a new submission can wake it immediately.
					const previous = Option.getOrUndefined(decodeInboxBackoff(kv.get(inboxBackoffKey)));
					const backoffMs =
						previous === undefined ? inboxHeartbeatMs : Math.min(previous * 2, maxInboxBackoffMs);
					kv.put(inboxBackoffKey, backoffMs);
					yield* Effect.logWarning("Inbox wake failed. Retrying after backoff.", error).pipe(
						Effect.annotateLogs({ attempt, backoffMs }),
					);
					return { rescheduleAt: now + backoffMs };
				}),
			);
		}
	}
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
		checkpoint({ kind, name }, result, run) {
			const checkpointJson = Schema.fromJsonString(result);
			return Effect.gen(function* () {
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
				return yield* Effect.promise(() =>
					step.do(
						name,
						{
							retries: kind === "model" ? { limit: 2, delay: "1 second" } : { limit: 1 },
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
									Effect.withSpan("harness.step.attempt", {
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
			}).pipe(Effect.withSpan("harness.checkpoint", { attributes: { runId, name } }));
		},
	};
}

export abstract class CloudflareHarness<
	Bindings extends object = object,
> extends DurableObject<Bindings> {
	protected abstract readonly turnLayer: Layer.Layer<TurnModel | TurnTools>;

	protected onTurnPhase?(phase: "before-task" | "after-commit", signal: AbortSignal): Promise<void>;
	protected onProgress?(runId: string, event: TurnProgress): void;
	protected onStateChange?(update: {
		readonly settledRunId?: string;
		readonly historyChanged: boolean;
	}): void;

	/** Archives outcomes and clears run state in the transaction that settles the turn. */
	protected settleRunState?(
		runId: string,
		outcome: "completed" | "failed" | "cancelled",
	): ReadonlyArray<typeof TurnMessage.Type> | undefined;

	protected describeRecoveredTool({
		name,
		status,
	}: typeof ToolActivity.Type): (typeof RuntimeOutcome.Type.tools)[number] {
		return { name, status };
	}

	readonly #conversation = new ConversationStore(
		this.ctx.storage,
		(runId, outcome) => this.settleRunState?.(runId, outcome),
		(activity) => this.describeRecoveredTool(activity),
	);
	readonly #inbox = new InboxWake(() => this.#drainInbox());
	readonly #tasks = new Tasks({
		onError: () => Effect.runPromise(this.#inbox.wake()),
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
	readonly lifecycle = Lifecycle.install(this).use(this.#tasks).use(this.#inbox);
	readonly #start = lifecycleEffect("start lifecycle", () => this.lifecycle.start());

	#getTask(runId: string) {
		return lifecycleEffect("get turn task", () => this.#tasks.handle(turnDefinition).get(runId));
	}

	#notifyState(settledRunId?: string, historyChanged = settledRunId !== undefined) {
		return publishUpdate("conversation state", () =>
			Effect.sync(() =>
				this.onStateChange?.({ historyChanged, ...(settledRunId && { settledRunId }) }),
			),
		);
	}

	onStart() {
		this.#conversation.initialize();
		const wake = this.#conversation.head() && !this.#inbox.hasWake();
		return Effect.runPromise(
			(wake ? this.#inbox.wake() : Effect.void).pipe(Effect.andThen(this.#notifyState())),
		);
	}

	#drainInbox = Effect.fn("harness.drainInbox")(function* (this: CloudflareHarness<Bindings>) {
		const head = yield* conversationEffect("read inbox", () => this.#conversation.head());
		if (!head) {
			return;
		}
		const runId = head.run_id;
		yield* Effect.annotateCurrentSpan("runId", runId);
		const task = yield* this.#getTask(runId);
		if (head.state === "stopping") {
			if (
				task &&
				task.state !== "failed" &&
				task.state !== "cancelled" &&
				task.state !== "completed"
			) {
				yield* lifecycleEffect("cancel turn task", () =>
					this.#tasks.handle(turnDefinition).cancel(runId),
				);
				return { rescheduleAt: (yield* Clock.currentTimeMillis) + 250 };
			}
			yield* conversationEffect("cancel turn", () => this.#conversation.cancel(runId));
			yield* this.#notifyState(runId);
			return "yield" as const;
		}
		if (!task) {
			yield* Effect.promise(async (signal) => this.onTurnPhase?.("before-task", signal));
			yield* lifecycleEffect("start turn task", () =>
				this.#tasks.run(turnDefinition, { runId }, { runId }),
			);
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
			yield* this.#notifyState(runId);
			yield* Effect.logWarning("Harness turn ended without a transcript").pipe(
				Effect.annotateLogs({ runId, code }),
			);
			return "yield" as const;
		}
		// A task that terminates before committing may never signal the inbox.
		return { rescheduleAt: (yield* Clock.currentTimeMillis) + inboxHeartbeatMs };
	});

	#runSubmission = Effect.fn("harness.runSubmission")(function* (
		this: CloudflareHarness<Bindings>,
		runId: string,
		step: TaskStep,
	) {
		yield* Effect.annotateCurrentSpan("runId", runId);
		const row = yield* conversationEffect("start turn", () => this.#conversation.start(runId));
		if (row.state !== "running") {
			return;
		}
		yield* this.#notifyState();
		const through = row.context_through;
		if (through === null) {
			return yield* new TurnIoError({
				operation: "read context",
				cause: null,
				message: "The turn has no context cursor.",
			});
		}
		const model = yield* TurnModel;
		const { context, modelContext, outcomesThrough } = yield* conversationEffect(
			"read context",
			() => {
				const saved = this.#conversation.modelContext();
				const outcomes = this.#conversation.runtimeOutcomes(through);
				const restored = restoreModelContext(model, saved);
				return {
					context: Option.isSome(restored)
						? outcomes.messages
						: [...this.#conversation.context(through), ...outcomes.messages],
					modelContext: Option.getOrUndefined(restored),
					outcomesThrough: outcomes.through,
				};
			},
		);
		const transcript = yield* runTurn(
			{ id: row.submission_id, prompt: row.prompt },
			taskJournal(runId, step),
			context,
			(event) => Effect.sync(() => this.onProgress?.(runId, event)),
			modelContext,
		);

		yield* conversationEffect("commit turn", () =>
			this.#conversation.commit(runId, transcript, outcomesThrough),
		);
		yield* this.#notifyState(runId);
		yield* Effect.promise(async (signal) => this.onTurnPhase?.("after-commit", signal));
		yield* this.#inbox.wake();
	});

	protected runState() {
		return this.#conversation.status();
	}

	protected snapshot() {
		return { ...this.runState(), page: this.#conversation.page({}) };
	}

	protected readPage(query: HistoryQuery) {
		return this.#start.pipe(
			Effect.andThen(conversationEffect("read history page", () => this.#conversation.page(query))),
		);
	}

	#withInbox = Effect.fnUntraced(function* <A>(
		this: CloudflareHarness<Bindings>,
		operation: string,
		run: () => A,
	) {
		yield* this.#start;
		const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
		// Schedule the wake before changing the inbox, under the same input gate.
		return yield* lifecycleEffect(operation, () =>
			this.ctx.blockConcurrencyWhile(() =>
				runPromise(this.#inbox.wake().pipe(Effect.andThen(conversationEffect(operation, run)))),
			),
		);
	});

	protected submitEffect(input: unknown) {
		return Schema.decodeUnknownEffect(TurnSubmission)(input).pipe(
			Effect.flatMap((submission) =>
				this.#withInbox("admit turn", () => this.#conversation.admit(submission)).pipe(
					Effect.tap(({ accepted }) => (accepted ? this.#notifyState() : Effect.void)),
				),
			),
			Effect.catchTag("SchemaError", (error) =>
				Effect.succeed({ accepted: false as const, runId: null, error: error.message }),
			),
		);
	}

	protected recordUnadmittedSubmission(submission: typeof TurnSubmission.Type, text: string) {
		return conversationEffect("record missed submission", () =>
			this.#conversation.recordUnadmittedSubmission(submission, text),
		).pipe(
			Effect.tap((recorded) => (recorded ? this.#notifyState(undefined, true) : Effect.void)),
			Effect.asVoid,
		);
	}

	protected stopEffect(runId: string) {
		return this.#withInbox("request turn stop", () => this.#conversation.requestStop(runId)).pipe(
			Effect.tap((stopped) => (stopped ? this.#notifyState() : Effect.void)),
			Effect.map((stopped) => ({ runId, stopped })),
		);
	}

	submit(input: unknown) {
		return Effect.runPromise(this.submitEffect(input));
	}

	stop(runId: string) {
		return Effect.runPromise(this.stopEffect(runId));
	}

	turn(runId: string) {
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				yield* this.#start;
				const turn = yield* conversationEffect("read turn", () => this.#conversation.turn(runId));
				if (turn.state !== "failed") {
					return { ...turn, failure: null };
				}
				// Tasks already retains the error name. Keep the transcript database's format.
				const task = yield* this.#getTask(runId);
				const code =
					task?.state === "failed"
						? failureCode(task.error.name)
						: task?.state === "cancelled"
							? "cancelled"
							: "execution";
				return { ...turn, failure: { code, message: turn.error ?? "The turn failed." } };
			}),
		);
	}

	history(query: HistoryQuery) {
		return Effect.runPromise(
			this.#start.pipe(
				Effect.andThen(conversationEffect("read history", () => this.#conversation.history(query))),
			),
		);
	}

	taskState(runId: string) {
		return Effect.runPromise(
			this.#getTask(runId).pipe(Effect.map((task) => task?.state ?? "missing")),
		);
	}
}
