import { tracing } from "cloudflare:workers";
import { channels } from "agents/observability";
import { Console, Effect, Option, Schema } from "effect";

const readTaskEvent = Schema.decodeUnknownOption(
	Schema.Struct({
		source: Schema.Literal("tasks"),
		type: Schema.Literals(["task:attempt:interrupted", "task:step:retry", "task:failed"]),
		payload: Schema.Struct({
			definition: Schema.NonEmptyString,
			runId: Schema.NonEmptyString,
			step: Schema.optionalKey(Schema.NullOr(Schema.String)),
			attempt: Schema.optionalKey(Schema.Natural),
			error: Schema.optionalKey(Schema.String),
		}),
	}),
);
const isErrorName = Schema.is(
	Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^[\w.-]+$/)),
);

export function observeTurnTasks(turnDefinition: string) {
	// One listener per isolate. A turn can outlive the request that started it.
	channels.task.subscribe((event: unknown) => {
		const decoded = readTaskEvent(event);
		if (Option.isNone(decoded) || decoded.value.payload.definition !== turnDefinition) {
			return;
		}
		const {
			type,
			payload: { runId, step, attempt, error },
		} = decoded.value;
		const fields = {
			runId,
			...(step && { step }),
			...(type === "task:attempt:interrupted" && { taskAttempt: attempt }),
			...(type === "task:step:retry" && { stepAttempt: attempt }),
			...(isErrorName(error) && { errorName: error }),
		};
		tracing.enterSpan(type, (span) => span.setAttributes(fields));
		Effect.runSync(Console.warn({ event: type, ...fields }));
	});
}
