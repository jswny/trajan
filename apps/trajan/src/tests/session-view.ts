import { Schema } from "effect";

const isSessionView = Schema.is(
	Schema.Struct({
		messages: Schema.Array(
			Schema.Struct({
				role: Schema.String,
				parts: Schema.Array(
					Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
				),
			}),
		),
		running: Schema.Boolean,
		error: Schema.NullOr(Schema.String),
	}),
);

/** Validate the fields tests read while preserving the complete wire value for comparisons. */
export function readSessionView(json: string) {
	const data: unknown = JSON.parse(json);
	if (!isSessionView(data)) {
		throw new Error("Invalid test session view");
	}
	return data;
}
