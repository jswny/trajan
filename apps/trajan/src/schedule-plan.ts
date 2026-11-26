import { DateTime, Option, Schema } from "effect";

const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DailyTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/));
const TimeZone = Schema.String.check(
	Schema.makeFilter(
		(zone) => Option.isSome(DateTime.zoneMakeNamed(zone)) || "Use an IANA time zone.",
	),
);
export const Weekly = Schema.Struct({
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
export const ScheduledTurn = Schema.Struct({
	prompt: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(2000)),
	when: Schema.Union([Once, Weekly]),
});
export function nextWeeklyRun(when: typeof Weekly.Type, after: number) {
	const [hour, minute] = when.time.split(":").map(Number);
	const today = DateTime.startOf(
		DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(after), when.timeZone),
		"day",
	);
	for (let offset = 0; offset <= days.length; offset++) {
		const day = DateTime.add(today, { days: offset });
		const { year, month, day: date } = DateTime.toParts(day);
		// Shift nonexistent wall times forward and choose the first repeated occurrence.
		const candidate = DateTime.makeZonedUnsafe(
			{ year, month, day: date, hour, minute },
			{
				timeZone: when.timeZone,
				adjustForTimeZone: true,
				disambiguation: "compatible",
			},
		);
		const time = DateTime.toEpochMillis(candidate);
		if (time > after && when.days.includes(days[DateTime.getPart(day, "weekDay")])) {
			return time;
		}
	}
	throw new Error("The weekly schedule has no next occurrence.");
}
