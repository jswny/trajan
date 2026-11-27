import { defineTool } from "@trajan/code-mode";
import { Effect, Schema, Semaphore } from "effect";
import { ScheduledTurn } from "./schedule-plan";
import type { TurnSchedules } from "./turn-schedules";

const ListInput = Schema.NullOr(Schema.Struct({ offset: Schema.optionalKey(Schema.Natural) }));
const CancelInput = Schema.Struct({ id: Schema.NonEmptyString });
const Schedule = Schema.Struct({
	...ScheduledTurn.fields,
	id: Schema.String,
	nextRunAt: Schema.String,
});
// Return full prompts while keeping each list result within Code Mode's value limit.
const pageSize = 5;

export const scheduleInstructions = [
	"Scheduling tools are exported by codemode:tools.",
	"scheduleTurn({ prompt, when: { type: 'once', at } }) schedules a turn at an ISO 8601 time with a UTC offset or Z. For relative times use await now() from codemode:runtime.",
	"scheduleTurn({ prompt, when: { type: 'weekly', days, time, timeZone } }) repeats on the selected days (sun, mon, tue, wed, thu, fri, sat) at HH:MM in an IANA time zone.",
	"listSchedules() lists upcoming schedules. Pass { offset: nextOffset } for more. cancelSchedule({ id }) stops future occurrences of that schedule.",
	"Create or cancel schedules only when the user asks. Ask if the schedule's time zone is unclear. Scheduled results appear in this chat.",
].join("\n");

export function createScheduleTools(schedules: Pick<TurnSchedules, "create" | "list" | "cancel">) {
	return {
		scheduleTurn: defineTool({
			// The Lifecycle job and its Code Mode receipt share the Durable Object database.
			replay: "atomic",
			mutationLock: Semaphore.makeUnsafe(1),
			input: ScheduledTurn,
			output: Schedule,
			run: (plan, { callId, signal }) => schedules.create(plan, callId, signal),
		}),
		listSchedules: defineTool({
			replay: "safe",
			input: ListInput,
			output: Schema.Struct({
				schedules: Schema.Array(Schedule),
				nextOffset: Schema.NullOr(Schema.Int),
			}),
			run: (input) => schedules.list(input?.offset ?? 0, pageSize),
		}),
		cancelSchedule: defineTool({
			replay: "safe",
			input: CancelInput,
			output: Schema.Struct({ id: Schema.String, status: Schema.Literal("inactive") }),
			run: ({ id }, { signal }) =>
				schedules.cancel(id, signal).pipe(Effect.as({ id, status: "inactive" as const })),
		}),
	};
}
