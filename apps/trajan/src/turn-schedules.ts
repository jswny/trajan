import { codeModeError, defineTool } from "@trajan/code-mode";
import { TurnSubmission } from "@trajan/harness";
import type { TurnIoError } from "@trajan/harness";
import { LifecycleCapability } from "agents/lifecycle";
import type { LifecycleJob, LifecycleJobContext } from "agents/lifecycle";
import { Clock, DateTime, Effect, Schema, Semaphore } from "effect";
import { nextWeeklyRun, ScheduledTurn } from "./schedule-plan";

const ListInput = Schema.NullOr(Schema.Struct({ offset: Schema.optionalKey(Schema.Natural) }));
const CancelInput = Schema.Struct({ id: Schema.NonEmptyString });
const Schedule = Schema.Struct({
	...ScheduledTurn.fields,
	id: Schema.String,
	nextRunAt: Schema.String,
});
const MissedOccurrence = Schema.Struct({
	scheduleId: Schema.NonEmptyString,
	scheduledFor: Schema.Natural,
	submission: TurnSubmission,
});
// Return full prompts while keeping each list result within Code Mode's value limit.
const pageSize = 5;
const scheduleJob = "submit-scheduled-turn";
const reportJob = "report-missed-scheduled-turn";
const reportRetryDelayMs = 30_000;

const JobFields = { id: Schema.NonEmptyString, time: Schema.Natural };
const DispatchJob = Schema.Struct({
	...JobFields,
	fn: Schema.Literal(scheduleJob),
	payload: ScheduledTurn,
});
const ReportJob = Schema.Struct({
	...JobFields,
	fn: Schema.Literal(reportJob),
	payload: MissedOccurrence,
});
const ScheduleJob = Schema.Union([DispatchJob, ReportJob]);
const decodeJob = Schema.decodeUnknownEffect(ScheduleJob);

function occurrence(job: typeof DispatchJob.Type, prompt: string): typeof TurnSubmission.Type {
	const date = DateTime.formatIso(DateTime.makeUnsafe(job.time));
	return {
		id: `scheduled:${job.id}:${job.time}`,
		prompt: `Scheduled task for ${date}\n\n${prompt}`,
	};
}

function describe(job: LifecycleJob, { prompt, when }: typeof ScheduledTurn.Type) {
	return {
		id: job.id,
		prompt,
		when,
		nextRunAt: DateTime.formatIso(DateTime.makeUnsafe(job.time)),
	};
}

export const scheduleInstructions = [
	"Scheduling tools are exported by codemode:tools.",
	"scheduleTurn({ prompt, when: { type: 'once', at } }) schedules a turn at an ISO 8601 time with a UTC offset or Z. For relative times use await now() from codemode:runtime.",
	"scheduleTurn({ prompt, when: { type: 'weekly', days, time, timeZone } }) repeats on the selected days (sun, mon, tue, wed, thu, fri, sat) at HH:MM in an IANA time zone.",
	"listSchedules() lists upcoming schedules. Pass { offset: nextOffset } for more. cancelSchedule({ id }) stops future occurrences of that schedule.",
	"Create or cancel schedules only when the user asks. Ask if the schedule's time zone is unclear. Scheduled results appear in this chat.",
].join("\n");

export class TurnSchedules extends LifecycleCapability {
	constructor(
		private readonly submit: (
			input: typeof TurnSubmission.Type,
		) => Effect.Effect<{ runId: string | null; error?: string }, TurnIoError>,
		private readonly recordMissed: (
			input: typeof TurnSubmission.Type,
			text: string,
		) => Effect.Effect<void, TurnIoError>,
	) {
		super("turn-schedules");
	}

	readonly tools = {
		scheduleTurn: defineTool({
			// The Lifecycle job and its Code Mode receipt share the Durable Object database.
			replay: "atomic",
			mutationLock: Semaphore.makeUnsafe(1),
			input: ScheduledTurn,
			output: Schedule,
			run: Effect.fnUntraced(function* (
				this: TurnSchedules,
				plan: typeof ScheduledTurn.Type,
				{ callId, signal }: { callId: string; signal: AbortSignal },
			) {
				const digest = yield* Effect.tryPromise(() =>
					crypto.subtle.digest("SHA-256", new TextEncoder().encode(callId)),
				);
				const id = Array.from(new Uint8Array(digest), (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
				const found = this.lifecycle.jobs.get(id);
				if (found) {
					yield* Effect.tryPromise(() => this.lifecycle.jobs.rearm());
					return describe(found, plan);
				}
				const now = yield* Clock.currentTimeMillis;
				const time =
					plan.when.type === "once"
						? DateTime.toEpochMillis(
								yield* Schema.decodeEffect(Schema.DateTimeUtcFromString)(plan.when.at),
							)
						: nextWeeklyRun(plan.when, now);
				if (time <= now) {
					return yield* codeModeError("Choose a future time for a one-time schedule.");
				}
				const job = yield* Effect.tryPromise(() => {
					signal.throwIfAborted();
					return this.lifecycle.jobs.push({ id, fn: scheduleJob, time, payload: plan });
				});
				return describe(job, plan);
			}).bind(this),
		}),
		listSchedules: defineTool({
			replay: "safe",
			input: ListInput,
			output: Schema.Struct({
				schedules: Schema.Array(Schedule),
				nextOffset: Schema.NullOr(Schema.Int),
			}),
			run: Effect.fnUntraced(function* (this: TurnSchedules, input: typeof ListInput.Type) {
				const { offset = 0 } = input ?? {};
				const jobs = this.lifecycle.jobs.list().filter(({ fn }) => fn === scheduleJob);
				const schedules = yield* Effect.forEach(jobs.slice(offset, offset + pageSize), (job) =>
					Schema.decodeUnknownEffect(ScheduledTurn)(job.payload).pipe(
						Effect.map((plan) => describe(job, plan)),
					),
				);
				return {
					schedules,
					nextOffset: offset + pageSize < jobs.length ? offset + pageSize : null,
				};
			}).bind(this),
		}),
		cancelSchedule: defineTool({
			replay: "safe",
			input: CancelInput,
			output: Schema.Struct({ id: Schema.String, status: Schema.Literal("inactive") }),
			run: Effect.fnUntraced(function* (
				this: TurnSchedules,
				{ id }: typeof CancelInput.Type,
				{ signal }: { signal: AbortSignal },
			) {
				yield* Effect.tryPromise(async () => {
					signal.throwIfAborted();
					if (this.lifecycle.jobs.get(id)?.fn === scheduleJob) {
						await this.lifecycle.jobs.cancel(id);
					}
				});
				return { id, status: "inactive" as const };
			}).bind(this),
		}),
	};

	readonly #advance = Effect.fnUntraced(function* (
		when: typeof ScheduledTurn.Type.when,
		time: number,
	) {
		if (when.type === "weekly") {
			const now = yield* Clock.currentTimeMillis;
			return { rescheduleAt: nextWeeklyRun(when, Math.max(now, time)) };
		}
	});

	readonly #runJob = Effect.fn("turn-schedules.submit")(function* (
		this: TurnSchedules,
		job: typeof DispatchJob.Type,
	) {
		yield* Effect.annotateCurrentSpan({ scheduleId: job.id, scheduledFor: job.time });
		const plan = job.payload;
		// The queue keeps the same due time through retries of this occurrence.
		const receipt = yield* this.submit(occurrence(job, plan.prompt));
		if (receipt.runId === null) {
			return yield* codeModeError(receipt.error ?? "Scheduled turn was rejected.");
		}
		return yield* this.#advance(plan.when, job.time);
	});

	onJob({ job }: LifecycleJobContext) {
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				const work = yield* decodeJob(job);
				if (work.fn === reportJob) {
					return yield* this.#runReport(work);
				}
				return yield* this.#runJob(work);
			}),
		);
	}

	#report(occurrence: typeof MissedOccurrence.Type, nextRun?: number) {
		const next =
			nextRun === undefined
				? ""
				: ` Next scheduled run is ${DateTime.formatIso(DateTime.makeUnsafe(nextRun))}.`;
		return this.recordMissed(
			occurrence.submission,
			`A scheduled task could not be queued after retries.${next}\n\n${occurrence.submission.prompt}`,
		);
	}

	readonly #runReport = Effect.fn("turn-schedules.reportMissed")(function* (
		this: TurnSchedules,
		job: typeof ReportJob.Type,
	) {
		const missed = job.payload;
		const next = this.lifecycle.jobs.get(missed.scheduleId)?.time;
		yield* this.#report(
			missed,
			next !== undefined && next > missed.scheduledFor ? next : undefined,
		);
	});

	onJobError({ job: rawJob }: LifecycleJobContext, dispatchError: unknown) {
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				const decoded = yield* Effect.result(decodeJob(rawJob));
				if (decoded._tag === "Failure") {
					return yield* Effect.logError("Invalid scheduled job payload", decoded.failure).pipe(
						Effect.annotateLogs({ jobId: rawJob.id }),
					);
				}
				const job = decoded.success;
				if (job.fn === reportJob) {
					yield* Effect.logWarning("Retrying the missed schedule report", dispatchError).pipe(
						Effect.annotateLogs({ jobId: job.id }),
					);
					return { rescheduleAt: (yield* Clock.currentTimeMillis) + reportRetryDelayMs };
				}
				const plan = job.payload;
				const outcome = yield* this.#advance(plan.when, job.time);
				const current = this.lifecycle.jobs.get(job.id);
				if (current?.time !== job.time) {
					return current && { rescheduleAt: current.time };
				}
				const missed: typeof MissedOccurrence.Type = {
					scheduleId: job.id,
					scheduledFor: job.time,
					submission: occurrence(job, plan.prompt),
				};
				return yield* this.#report(missed, outcome?.rescheduleAt).pipe(
					Effect.as(outcome),
					Effect.catch((error) =>
						this.#deferReport(missed, error).pipe(
							Effect.matchEffect({
								onSuccess: () => Effect.succeed(outcome),
								onFailure: (enqueueError) =>
									Effect.logError(
										"Could not retain the scheduled turn outcome",
										enqueueError,
										dispatchError,
									).pipe(
										Effect.annotateLogs({ scheduleId: job.id, scheduledFor: job.time }),
										// Keep the original occurrence due if queuing its report also failed.
										Effect.as("yield" as const),
									),
							}),
						),
					),
				);
			}),
		);
	}

	readonly #deferReport = Effect.fnUntraced(function* (
		this: TurnSchedules,
		missed: typeof MissedOccurrence.Type,
		cause: TurnIoError,
	) {
		const time = (yield* Clock.currentTimeMillis) + reportRetryDelayMs;
		// The original schedule can advance once this occurrence has a durable report job.
		yield* Effect.tryPromise(() =>
			this.lifecycle.jobs.push({
				id: `report:${missed.submission.id}`,
				fn: reportJob,
				time,
				payload: missed,
			}),
		);
		yield* Effect.logWarning("Deferred the missed schedule report", cause).pipe(
			Effect.annotateLogs({ scheduleId: missed.scheduleId, scheduledFor: missed.scheduledFor }),
		);
	});
}
