import { DurableObject } from "cloudflare:workers";
import { runTurn, TurnIoError, TurnModelError, TurnSubmission } from "@trajan/effect-harness";
import type { TurnJournal, TurnModel, TurnTools } from "@trajan/effect-harness";
import { Lifecycle } from "agents/lifecycle";
import type { LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { Tasks } from "agents/tasks";
import type { TaskStep } from "agents/tasks";
import { Clock, Effect, Schema } from "effect";
import type { Layer } from "effect";
import { ConversationStore } from "./conversation-store";
import type { HistoryQuery } from "./conversation-store";

const turnDefinition = "turn@v3";
const inboxJob = "effect-harness-inbox";
const TurnTaskInput = Schema.Struct({ runId: Schema.NonEmptyString });

class TurnTaskInputError extends Schema.TaggedError<TurnTaskInputError>()("TurnTaskInputError", {
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
				return yield* Effect.tryPromise({
					try: () =>
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
					catch: (cause) => cause,
				}).pipe(
					Effect.catch((error) => {
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
		);

		yield* conversationEffect("commit turn", () => this.#conversation.commit(runId, transcript));
		yield* Effect.promise(async (signal) => this.onTurnPhase?.("after-commit", signal));
		yield* this.#wakeInbox();
	});

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
