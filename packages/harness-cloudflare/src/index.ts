import { DurableObject } from "cloudflare:workers";
import {
	publishUpdate,
	restoreModelContext,
	runTurn,
	ToolCall,
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
import { Streams } from "agents/streams";
import { NonRetryableError, Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { Clock, Effect, Option, Schedule, Schema } from "effect";
import type { Layer } from "effect";
import { ConversationStore } from "./conversation-store";
import type { HistoryQuery } from "./conversation-store";
import { ModelDrafts } from "./model-drafts";

// Tasks and jobs use these names to look up work persisted by prior isolates.
const turnDefinition = "turn@v3";
const inboxWakeJob = "harness-inbox:wake";
const inboxBackoffKey = "harness-inbox:wake-backoff";
const taskJournalPruneJob = "harness-task-retention:prune";
const dayMs = 24 * 60 * 60 * 1000;
const taskJournalRetentionMs = 7 * dayMs;
const taskJournalPruneLimit = 50;
const inboxHeartbeatMs = 30_000;
const maxInboxBackoffMs = 10 * 60_000;
const stepRestartLimit = 5;
const modelAttemptLimit = 4;
const modelRetryDelayMs = 1000;
const decodeInboxBackoff = Schema.decodeUnknownOption(Schema.Natural);
const TurnTaskInput = Schema.Struct({ runId: Schema.NonEmptyString });
const decodeStepInterruptions = Schema.decodeUnknownSync(
	Schema.UndefinedOr(
		Schema.Struct({ name: Schema.NonEmptyString, attempt: Schema.Natural, count: Schema.Natural }),
	),
);
const stepInterruptionsKey = (runId: string) => `harness-turn:interruptions:${runId}`;
const toolHandoffPrefix = (runId: string) => `harness-tool-handoff:${runId}:`;
const decodeToolHandoff = Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String));
const isRetryableHandoffFailure = Schema.is(
	Schema.Struct({
		retryable: Schema.Literal(true),
		overloaded: Schema.optionalKey(Schema.Literal(false)),
		durableObjectReset: Schema.optionalKey(Schema.Literal(false)),
	}),
);
const isToolCall = Schema.is(ToolCall);

type ToolHandoffPhase = "before-tool-handoff" | "after-tool-handoff";
type TurnPhase = "before-task" | "before-turn" | "after-commit" | ToolHandoffPhase;

class TurnTaskInputError extends Schema.TaggedError<
	TurnTaskInputError,
	{ readonly brand: unique symbol }
>()("TurnTaskInputError", {
	message: Schema.String,
}) {}

class TurnCommitError extends Schema.TaggedError<
	TurnCommitError,
	{ readonly brand: unique symbol }
>()("TurnCommitError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

class StepRestartLimitError extends NonRetryableError {
	readonly _tag = "StepRestartLimitError";
	override name = this._tag;

	constructor() {
		super(
			`The turn stopped after ${stepRestartLimit} consecutive interruptions of the same tool step.`,
		);
	}
}

class ModelInterruptedError extends Error {
	override name = "ModelInterruptedError";

	constructor() {
		super("The model request was interrupted and its retry budget is exhausted.");
	}
}

class NonRetryableModelError extends NonRetryableError {
	constructor(readonly modelError: TurnModelError) {
		super(modelError.message, { cause: modelError });
		this.name = modelError.name;
	}
}

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

class TaskJournalRetention extends LifecycleCapability {
	constructor(private readonly prune: (settledBefore: Date) => Effect.Effect<number, TurnIoError>) {
		super("harness-task-retention");
	}

	onStart() {
		return Effect.runPromise(
			publishUpdate("schedule task journal retention", () =>
				Effect.gen({ self: this }, function* () {
					if (this.lifecycle.jobs.get(taskJournalPruneJob) === undefined) {
						const now = yield* Clock.currentTimeMillis;
						yield* lifecycleEffect("schedule task journal retention", () =>
							this.lifecycle.jobs.push({ id: taskJournalPruneJob, fn: "prune", time: now + dayMs }),
						);
					}
				}),
			),
		);
	}

	onJob({ job }: LifecycleJobContext) {
		if (job.id === taskJournalPruneJob) {
			return Effect.runPromise(
				Effect.gen({ self: this }, function* () {
					const now = yield* Clock.currentTimeMillis;
					const count = yield* this.prune(new Date(now - taskJournalRetentionMs));
					return count === taskJournalPruneLimit
						? ("yield" as const)
						: { rescheduleAt: now + dayMs };
				}),
			);
		}
	}

	onJobError({ job }: LifecycleJobContext, error: unknown) {
		if (job.id === taskJournalPruneJob) {
			return Effect.runPromise(
				Effect.logWarning("Task journal cleanup failed", error).pipe(
					Effect.andThen(Clock.currentTimeMillis),
					Effect.map((now) => ({ rescheduleAt: now + dayMs })),
				),
			);
		}
	}
}

function failureCode(name: string) {
	switch (name) {
		case "TurnModelError":
			return "model";
		case "ModelInterruptedError":
			return "model_interrupted";
		case "TurnTaskInputError":
			return "task-input";
		case "TurnCommitError":
			return "transcript_commit";
		case "StepRestartLimitError":
			return "restart_limit";
		case "SchemaError":
			return "schema";
		default:
			return "execution";
	}
}

const recordInterruption = Effect.fnUntraced(function* (
	storage: DurableObjectStorage,
	runId: string,
	{ name, attempt }: NonNullable<TaskStep["interrupted"]>,
) {
	const key = stepInterruptionsKey(runId);
	const count = storage.transactionSync(() => {
		const previous = decodeStepInterruptions(storage.kv.get(key));
		if (previous?.name === name && previous.attempt === attempt) {
			return previous.count;
		}
		// An ordinary retry breaks the sequence because it never reports an interruption.
		const count =
			previous?.name === name && previous.attempt + 1 === attempt ? previous.count + 1 : 1;
		storage.kv.put(key, { name, attempt, count });
		return count;
	});
	yield* Effect.promise(() => storage.sync());
	return count;
});

function taskJournal(
	runId: string,
	step: TaskStep,
	storage: DurableObjectStorage,
	drafts: ModelDrafts,
	onHandoff: ((phase: ToolHandoffPhase, signal: AbortSignal) => Promise<void>) | undefined,
): TurnJournal {
	return {
		checkpoint(checkpoint, result, run) {
			const { kind, name } = checkpoint;
			const checkpointJson = Schema.fromJsonString(result);
			const handoffKey =
				checkpoint.kind === "model"
					? toolHandoffPrefix(runId) + step.idempotencyKey(checkpoint.nextTool)
					: undefined;
			const readHandoff =
				handoffKey === undefined
					? Effect.undefined
					: conversationEffect("read tool handoff", () => storage.kv.get(handoffKey)).pipe(
							Effect.flatMap(decodeToolHandoff),
						);
			const saveDecision = Effect.fnUntraced(function* (
				value: typeof result.Type,
				signal: AbortSignal,
			) {
				const encoded = yield* Schema.encodeEffect(checkpointJson)(value);
				if (handoffKey === undefined || !isToolCall(value)) {
					return encoded;
				}
				yield* Effect.gen(function* () {
					if (onHandoff) {
						yield* lifecycleEffect("prepare tool handoff", () =>
							onHandoff("before-tool-handoff", signal),
						);
					}
					yield* drafts.applyDecision(runId, name, () => {
						signal.throwIfAborted();
						if (storage.kv.get(handoffKey) === undefined) {
							storage.kv.put(handoffKey, encoded);
						}
					});
					yield* lifecycleEffect("flush tool handoff", () => storage.sync());
				}).pipe(
					Effect.retry({
						times: 2,
						schedule: Schedule.spaced("100 millis"),
						while: ({ cause }) => isRetryableHandoffFailure(cause),
					}),
				);
				if (onHandoff) {
					yield* Effect.promise(() => onHandoff("after-tool-handoff", signal));
				}
				// The SDK acknowledges the step while the handoff owns the tool decision.
				return null;
			});
			const interrupted = step.interrupted?.name === name ? step.interrupted : null;
			const restartBudget =
				interrupted && kind === "tool"
					? recordInterruption(storage, runId, interrupted).pipe(
							Effect.flatMap((count) =>
								count >= stepRestartLimit ? Effect.fail(new StepRestartLimitError()) : Effect.void,
							),
						)
					: Effect.void;
			return Effect.gen(function* () {
				const savedHandoff = yield* readHandoff;
				if (kind === "model" && interrupted && savedHandoff === undefined) {
					yield* drafts.interrupt(runId, name, interrupted.attempt);
					if (interrupted.attempt >= modelAttemptLimit) {
						return yield* Effect.die(new ModelInterruptedError());
					}
					// The SDK reports the lost attempt once. Its sleep parks this run until the retry is due.
					yield* Effect.promise(() =>
						step.sleep(
							`${name}:recover:${interrupted.attempt}`,
							modelRetryDelayMs * 2 ** (interrupted.attempt - 1),
						),
					);
				}
				const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
				const encoded = yield* Effect.promise(() =>
					step.do(
						name,
						{
							retries:
								kind === "model"
									? { limit: modelAttemptLimit, delay: modelRetryDelayMs, backoff: "exponential" }
									: { limit: 1 },
						},
						({ attempt, idempotencyKey, signal }) => {
							if (savedHandoff !== undefined) {
								// Settle the SDK step after a reset between the handoff and its acknowledgment.
								return Promise.resolve(null);
							}
							const input = {
								runId,
								idempotencyKey,
								recovering: interrupted !== null || attempt > 1,
							};
							return runPromise(
								restartBudget.pipe(
									Effect.flatMap(() =>
										kind === "model"
											? drafts.capture(runId, name, attempt, (recordText) =>
													run({ ...input, recordText }),
												)
											: run(input),
									),
									Effect.flatMap(Schema.decodeUnknownEffect(result)),
									Effect.flatMap((value) => saveDecision(value, signal)),
									Effect.mapError((error) =>
										error instanceof TurnModelError && !error.retryable
											? new NonRetryableModelError(error)
											: error,
									),
									Effect.withSpan("harness.step.attempt", {
										attributes: { runId, name, attempt },
									}),
								),
								{ signal },
							);
						},
					),
				).pipe(
					Effect.catchDefect((error) => {
						if (error instanceof NonRetryableModelError) {
							return Effect.fail(error.modelError);
						}
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
				);
				if (encoded === null) {
					const handoff = savedHandoff ?? (yield* readHandoff);
					const decision = yield* Schema.decodeUnknownEffect(checkpointJson)(handoff);
					if (!isToolCall(decision)) {
						return yield* new TurnIoError({
							operation: "read tool handoff",
							message: "The tool handoff does not contain a tool decision.",
							cause: null,
						});
					}
					return decision;
				}
				const decision = yield* Schema.decodeEffect(checkpointJson)(encoded);
				if (kind === "model" && isToolCall(decision)) {
					yield* drafts.applyDecision(runId, name, () => {});
				}
				return decision;
			}).pipe(Effect.withSpan("harness.checkpoint", { attributes: { runId, name } }));
		},
	};
}

export abstract class CloudflareHarness<
	Bindings extends object = object,
> extends DurableObject<Bindings> {
	protected abstract readonly turnLayer: Layer.Layer<TurnModel | TurnTools>;

	protected onTurnPhase?(phase: TurnPhase, signal: AbortSignal): Promise<void>;
	protected onProgress?(runId: string, event: TurnProgress): void;
	protected onStateChange?(update: {
		readonly settledRunId?: string;
		readonly historyChanged: boolean;
	}): void | Promise<void>;

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

	readonly #streams = new Streams();
	readonly #drafts = new ModelDrafts(this.ctx.storage, this.#streams, (runId) =>
		this.onProgress?.(runId, { type: "reset" }),
	);
	readonly #conversation = new ConversationStore(
		this.ctx.storage,
		(runId, outcome) => {
			this.ctx.storage.kv.delete(stepInterruptionsKey(runId));
			const handoffs = this.ctx.storage.kv.list({ prefix: toolHandoffPrefix(runId) });
			for (const [key] of Array.from(handoffs)) {
				this.ctx.storage.kv.delete(key);
			}
			return this.settleRunState?.(runId, outcome);
		},
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
	readonly #taskJournalRetention = new TaskJournalRetention((settledBefore) =>
		lifecycleEffect("prune task journals", () =>
			this.ctx.blockConcurrencyWhile(async () => {
				// A terminal SDK task can still be evidence needed to settle the inbox head.
				if (this.#conversation.head()) {
					return 0;
				}
				return this.#tasks.delete({
					status: ["completed"],
					settledBefore,
					limit: taskJournalPruneLimit,
				});
			}),
		),
	);
	readonly lifecycle = Lifecycle.install(this)
		.use(this.#streams)
		.use(this.#tasks)
		.use(this.#inbox)
		.use(this.#taskJournalRetention);
	readonly #start = lifecycleEffect("start lifecycle", () => this.lifecycle.start());

	#getTask(runId: string) {
		return lifecycleEffect("get turn task", () => this.#tasks.handle(turnDefinition).get(runId));
	}

	#notifyState(settledRunId?: string, historyChanged = settledRunId !== undefined) {
		return publishUpdate("conversation state", () =>
			Effect.promise(async () =>
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
			yield* this.#drafts.settle(runId, true, (settle) => this.#conversation.cancel(runId, settle));
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
			yield* this.#drafts.settle(runId, true, (settle) =>
				this.#conversation.fail(runId, message, settle),
			);
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
		yield* Effect.promise(async (signal) => this.onTurnPhase?.("before-turn", signal));
		const transcript = yield* runTurn(
			{ id: row.submission_id, prompt: row.prompt },
			taskJournal(runId, step, this.ctx.storage, this.#drafts, this.onTurnPhase?.bind(this)),
			context,
			(event) => Effect.sync(() => this.onProgress?.(runId, event)),
			modelContext,
		);

		const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
		// Replay can reconstruct the transcript from completed steps without storing a second copy.
		yield* Effect.promise(() =>
			step.do("commit-transcript", { retries: { limit: 5, delay: "1 second" } }, ({ signal }) =>
				runPromise(
					this.#drafts
						.settle(runId, false, (settle) =>
							this.#conversation.commit(runId, transcript, outcomesThrough, settle),
						)
						.pipe(
							Effect.mapError(
								(cause) =>
									new TurnCommitError({
										message:
											"The model finished, but its reply could not be saved to the conversation.",
										cause,
									}),
							),
							Effect.tapError(({ cause }) => Effect.logWarning("Transcript write failed", cause)),
						),
					{ signal },
				),
			),
		);
		yield* this.#notifyState(runId);
		yield* Effect.promise(async (signal) => this.onTurnPhase?.("after-commit", signal));
		yield* this.#inbox.wake();
	});

	protected runState() {
		return this.#conversation.status();
	}

	protected readModelDraft(runId: string) {
		return this.#drafts.read(runId);
	}

	protected readInterruptedDrafts(runId: string) {
		return this.#drafts.readInterrupted(runId);
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
