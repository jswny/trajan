import type { CodeModeTool } from "@trajan/code-mode";
import type { TurnIoError, TurnSubmission } from "@trajan/harness";
import { LifecycleCapability } from "agents/lifecycle";
import type { LifecycleJob, LifecycleJobContext } from "agents/lifecycle";
import { Clock, DateTime, Effect, Option, Schema, Semaphore } from "effect";
import { codeModeError } from "./workspace";

const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DailyTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/));
const TimeZone = Schema.String.check(
	Schema.makeFilter(
		(zone) => Option.isSome(DateTime.zoneMakeNamed(zone)) || "Use an IANA time zone.",
	),
);
const Weekly = Schema.Struct({
	type: Schema.Literal("weekly"),
	days: Schema.NonEmptyArray(Schema.Literals(days)).check(Schema.isMaxLength(days.length)),
	time: DailyTime,
	timeZone: TimeZone,
});
const Once = Schema.Struct({
	type: Schema.Literal("once"),
	at: Schema.String.check(
		Schema.isPattern(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/,
		),
	),
});
const ScheduledTurn = Schema.Struct({
	prompt: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(2000)),
	when: Schema.Union([Once, Weekly]),
});
const ListInput = Schema.NullOr(Schema.Struct({ offset: Schema.optionalKey(Schema.Natural) }));
const CancelInput = Schema.Struct({ id: Schema.NonEmptyString });
// Return full prompts while keeping each list result within Code Mode's value limit.
const pageSize = 5;
const scheduleJob = "submit-scheduled-turn";

export function nextWeeklyRun(when: typeof Weekly.Type, after: number) {
	const [hour, minute] = when.time.split(":").map(Number);
	const today = DateTime.startOf(
		DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(after), when.timeZone),
		"day",
	);
	for (let offset = 0; offset <= days.length; offset++) {
		const day = DateTime.add(today, { days: offset });
		const candidate = DateTime.setParts(day, { hour, minute, second: 0, millisecond: 0 });
		const time = DateTime.toEpochMillis(candidate);
		if (time > after && when.days.includes(days[DateTime.getPart(day, "weekDay")])) {
			return time;
		}
	}
	throw new Error("The weekly schedule has no next occurrence.");
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
	) {
		super("turn-schedules");
	}

	readonly tools = {
		scheduleTurn: {
			// The Lifecycle job and its Code Mode receipt share the Durable Object database.
			replay: "atomic",
			mutationLock: Semaphore.makeUnsafe(1),
			run: Effect.fnUntraced(function* (
				this: TurnSchedules,
				...[input, { callId, signal }]: Parameters<CodeModeTool["run"]>
			) {
				const plan = yield* Schema.decodeUnknownEffect(ScheduledTurn)(input);
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
			}, Effect.mapError(codeModeError)).bind(this),
		},
		listSchedules: {
			replay: "safe",
			run: Effect.fnUntraced(function* (this: TurnSchedules, input: Schema.Json) {
				const { offset = 0 } = (yield* Schema.decodeUnknownEffect(ListInput)(input)) ?? {};
				const jobs = this.lifecycle.jobs.list();
				const schedules = yield* Effect.forEach(jobs.slice(offset, offset + pageSize), (job) =>
					Schema.decodeUnknownEffect(ScheduledTurn)(job.payload).pipe(
						Effect.map((plan) => describe(job, plan)),
					),
				);
				return {
					schedules,
					nextOffset: offset + pageSize < jobs.length ? offset + pageSize : null,
				};
			}, Effect.mapError(codeModeError)).bind(this),
		},
		cancelSchedule: {
			replay: "safe",
			run: Effect.fnUntraced(function* (
				this: TurnSchedules,
				...[input, { signal }]: Parameters<CodeModeTool["run"]>
			) {
				const { id } = yield* Schema.decodeUnknownEffect(CancelInput)(input);
				yield* Effect.tryPromise(async () => {
					signal.throwIfAborted();
					await this.lifecycle.jobs.cancel(id);
				});
				return { id, status: "inactive" };
			}, Effect.mapError(codeModeError)).bind(this),
		},
	} satisfies Record<string, CodeModeTool>;

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
		job: LifecycleJob,
	) {
		yield* Effect.annotateCurrentSpan({ scheduleId: job.id, scheduledFor: job.time });
		const plan = yield* Schema.decodeUnknownEffect(ScheduledTurn)(job.payload);
		const date = DateTime.formatIso(DateTime.makeUnsafe(job.time));
		// The queue keeps the same due time through retries of this occurrence.
		const receipt = yield* this.submit({
			id: `scheduled:${job.id}:${job.time}`,
			prompt: `Scheduled task for ${date}\n\n${plan.prompt}`,
		});
		if (receipt.runId === null) {
			return yield* codeModeError(receipt.error ?? "Scheduled turn was rejected.");
		}
		return yield* this.#advance(plan.when, job.time);
	});

	onJob({ job }: LifecycleJobContext) {
		return Effect.runPromise(this.#runJob(job));
	}

	onJobError({ job }: LifecycleJobContext, error: unknown) {
		return Effect.runPromise(
			Effect.logError("Scheduled turn could not be queued", error).pipe(
				Effect.annotateLogs({ scheduleId: job.id, scheduledFor: job.time }),
				Effect.andThen(Schema.decodeUnknownEffect(ScheduledTurn)(job.payload)),
				Effect.flatMap(({ when }) => this.#advance(when, job.time)),
			),
		);
	}
}
