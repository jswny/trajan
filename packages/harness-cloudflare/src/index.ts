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
import { NonRetryableError, Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { Clock, Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { ConversationStore } from "./conversation-store";
import type { HistoryQuery } from "./conversation-store";
import { ModelDrafts } from "./model-drafts";

// Tasks and jobs use these names to look up work persisted by prior isolates.
const turnDefinition = "turn@v3";
const inboxWakeJob = "harness-inbox:wake";
const inboxBackoffKey = "harness-inbox:wake-backoff";
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
const isToolCall = Schema.is(ToolCall);

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
): TurnJournal {
	return {
		checkpoint({ kind, name }, result, run) {
			const checkpointJson = Schema.fromJsonString(result);
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
				if (kind === "model" && interrupted) {
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
				return yield* Effect.promise(() =>
					step.do(
						name,
						{
							retries:
								kind === "model"
									? { limit: modelAttemptLimit, delay: modelRetryDelayMs, backoff: "exponential" }
									: { limit: 1 },
						},
						({ attempt, idempotencyKey, signal }) => {
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
									Effect.flatMap(Schema.encodeEffect(checkpointJson)),
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
					Effect.flatMap(Schema.decodeEffect(checkpointJson)),
					Effect.tap((value) =>
						kind === "model" && isToolCall(value)
							? Effect.sync(() => drafts.clearCheckpoint(runId, name))
							: Effect.void,
					),
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

	readonly #drafts = new ModelDrafts(this.ctx.storage, (runId) =>
		this.onProgress?.(runId, { type: "reset" }),
	);
	readonly #conversation = new ConversationStore(
		this.ctx.storage,
		(runId, outcome) => {
			this.ctx.storage.kv.delete(stepInterruptionsKey(runId));
			return [
				...(this.settleRunState?.(runId, outcome) ?? []),
				...this.#drafts.settle(runId, outcome !== "completed"),
			];
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
			taskJournal(runId, step, this.ctx.storage, this.#drafts),
			context,
			(event) => Effect.sync(() => this.onProgress?.(runId, event)),
			modelContext,
		);

		const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
		// Replay can reconstruct the transcript from completed steps without storing a second copy.
		yield* Effect.promise(() =>
			step.do("commit-transcript", { retries: { limit: 5, delay: "1 second" } }, ({ signal }) =>
				runPromise(
					Effect.try({
						try: () => this.#conversation.commit(runId, transcript, outcomesThrough),
						catch: (cause) =>
							new TurnCommitError({
								message:
									"The model finished, but its reply could not be saved to the conversation.",
								cause,
							}),
					}).pipe(
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
