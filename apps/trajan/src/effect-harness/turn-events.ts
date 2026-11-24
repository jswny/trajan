import { Schema } from "effect";

const text = { text: Schema.String };
export const TurnStreamEvent = Schema.Union([
	Schema.Struct({ type: Schema.Literal("draft"), ...text }),
	Schema.Struct({ type: Schema.Literal("text-delta"), ...text }),
	Schema.Struct({
		type: Schema.Literal("settled"),
		state: Schema.Literals(["completed", "failed", "missing"]),
	}),
]);
