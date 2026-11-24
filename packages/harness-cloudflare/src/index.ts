import { DurableObject } from "cloudflare:workers";
import { runTurn, TurnIoError, TurnModel, TurnModelError, TurnSubmission } from "@trajan/harness";
import type { TurnJournal, TurnProgress, TurnTools } from "@trajan/harness";
import { Lifecycle } from "agents/lifecycle";
import type { LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { Clock, Effect, Schema } from "effect";
import type { Layer } from "effect";
import { ConversationStore } from "./conversation-store";
import type { HistoryQuery } from "./conversation-store";

// Tasks and jobs use these names to look up work persisted by prior isolates.
const turnDefinition = "turn@v3";
const inboxJob = "harness-inbox";
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
	protected onStateChange?(settledRunId?: string): void;

	/** Runs in the storage transaction that settles the turn. */
	protected clearRunState?(runId: string): undefined;

	readonly #conversation = new ConversationStore(this.ctx.storage, (runId) =>
		this.clearRunState?.(runId),
	);
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
		this.onStateChange?.();
		if (this.#conversation.head() && !this.lifecycle.jobs.get(inboxJob)) {
			return Effect.runPromise(this.#wakeInbox());
		}
	}

	#wakeInbox = Effect.fnUntraced(function* (this: CloudflareHarness<Bindings>) {
		const time = yield* Clock.currentTimeMillis;
		yield* Effect.promise(() => this.lifecycle.jobs.push({ id: inboxJob, fn: inboxJob, time }));
	});

	onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> | undefined {
		if (job.fn === inboxJob) {
			return Effect.runPromise(this.#drainInbox());
		}
	}

	#drainInbox = Effect.fn("harness.drainInbox")(function* (this: CloudflareHarness<Bindings>) {
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
			yield* Effect.sync(() => this.onStateChange?.(runId));
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
			yield* Effect.sync(() => this.onStateChange?.(runId));
			yield* Effect.logWarning("Harness turn ended without a transcript").pipe(
				Effect.annotateLogs({ runId, code }),
			);
			return "yield" as const;
		}
		// A task that terminates before committing may never signal the inbox.
		return { rescheduleAt: (yield* Clock.currentTimeMillis) + 30_000 };
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
		yield* Effect.sync(() => this.onStateChange?.());
		const through = row.context_through;
		if (through === null) {
			return yield* new TurnIoError({
				operation: "read context",
				cause: null,
				message: "The turn has no context cursor.",
			});
		}
		const { contextFormat } = yield* TurnModel;
		const { context, modelContext } = yield* conversationEffect("read context", () => {
			const saved = this.#conversation.modelContext();
			if (saved?.adapter === contextFormat.adapter && saved.version === contextFormat.version) {
				return { context: [], modelContext: saved.state };
			}
			return { context: this.#conversation.context(through), modelContext: undefined };
		});
		const transcript = yield* runTurn(
			{ id: row.submission_id, prompt: row.prompt },
			taskJournal(runId, step),
			context,
			(event) => Effect.sync(() => this.onProgress?.(runId, event)),
			modelContext,
		);

		yield* conversationEffect("commit turn", () => this.#conversation.commit(runId, transcript));
		yield* Effect.sync(() => this.onStateChange?.(runId));
		yield* Effect.promise(async (signal) => this.onTurnPhase?.("after-commit", signal));
		yield* this.#wakeInbox();
	});

	protected snapshot() {
		return { ...this.#conversation.status(), page: this.#conversation.page({}) };
	}

	protected async page(query: HistoryQuery) {
		await this.lifecycle.start();
		return this.#conversation.page(query);
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
								this.onStateChange?.();
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
				this.onStateChange?.();
			}
			return { runId, stopped };
		});
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

	async history(query: HistoryQuery) {
		await this.lifecycle.start();
		return this.#conversation.history(query);
	}

	async taskState(runId: string) {
		return (await this.#tasks.handle(turnDefinition).get(runId))?.state ?? "missing";
	}
}
