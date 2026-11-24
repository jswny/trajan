import { Context, Effect, Schema } from "effect";

export const TurnSubmission = Schema.Struct({
	id: Schema.NonEmptyString,
	prompt: Schema.NonEmptyString,
});

const UserMessage = Schema.Struct({
	role: Schema.Literal("user"),
	text: Schema.NonEmptyString,
});

const Reply = Schema.Struct({
	role: Schema.Literal("assistant"),
	text: Schema.NonEmptyString,
});

const ToolCall = Schema.Struct({
	role: Schema.Literal("tool-call"),
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	input: Schema.Json,
});

export const ToolResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Json }),
	Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
	Schema.Struct({ status: Schema.Literal("unknown"), message: Schema.String }),
]);

const ToolMessage = Schema.Struct({
	role: Schema.Literal("tool"),
	callId: Schema.NonEmptyString,
	result: ToolResult,
});

export const TurnMessage = Schema.Union([UserMessage, Reply, ToolCall, ToolMessage]);
export const ConversationMessage = Schema.Union([UserMessage, Reply]);
const ModelToolCall = Schema.Struct({
	...ToolCall.fields,
	// Adapter context belongs to the checkpointed model response.
	continuation: Schema.optionalKey(Schema.Json),
});
const ModelResponse = Schema.Union([Reply, ModelToolCall]);

type ModelHistoryEntry =
	| typeof ConversationMessage.Type
	| typeof ModelToolCall.Type
	| typeof ToolMessage.Type;
const MAX_TOOL_CALLS = 8;

export const TurnTranscript = Schema.Struct({
	submissionId: Schema.NonEmptyString,
	messages: Schema.Array(TurnMessage),
});

export class TurnIoError extends Schema.TaggedError<TurnIoError>()("TurnIoError", {
	operation: Schema.String,
	cause: Schema.Defect(),
	message: Schema.optionalKey(Schema.String),
}) {}

export class TurnModelError extends Schema.TaggedError<TurnModelError>()("TurnModelError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

type TurnError = TurnIoError | TurnModelError | Schema.SchemaError;

export interface StepAttempt {
	readonly idempotencyKey: string;
	/** An earlier attempt may have started this step's external work. */
	readonly recovering: boolean;
}

export interface TurnJournal {
	/** Save one result per step name and return it on subsequent executions. */
	readonly checkpoint: <A extends Schema.Json>(
		name: string,
		result: Schema.Codec<A>,
		run: (attempt: StepAttempt) => Effect.Effect<unknown, TurnError>,
	) => Effect.Effect<A, TurnError>;
}

export class TurnModel extends Context.Service<
	TurnModel,
	{
		readonly complete: (
			messages: ReadonlyArray<ModelHistoryEntry>,
			options: { readonly allowTools: boolean },
		) => Effect.Effect<unknown, TurnModelError>;
	}
>()("@trajan/effect-harness/TurnModel") {}

export class TurnTools extends Context.Service<
	TurnTools,
	{
		readonly execute: (
			call: typeof ToolCall.Type,
			attempt: StepAttempt,
		) => Effect.Effect<unknown, TurnError>;
	}
>()("@trajan/effect-harness/TurnTools") {}

/** Run a turn until the model replies, with a checkpoint for each decision and tool result. */
export const runTurn = Effect.fn("effect-harness.runTurn")(function* (
	submission: typeof TurnSubmission.Type,
	journal: TurnJournal,
	context: ReadonlyArray<typeof ConversationMessage.Type> = [],
) {
	const model = yield* TurnModel;
	const tools = yield* TurnTools;
	const history: ModelHistoryEntry[] = [...context, { role: "user", text: submission.prompt }];

	for (let index = 0; ; index++) {
		const allowTools = index < MAX_TOOL_CALLS;
		const decision = yield* journal.checkpoint(
			`model:${index}`,
			allowTools ? ModelResponse : Reply,
			() => model.complete([...history], { allowTools }),
		);

		if (decision.role === "assistant") {
			// Project the transcript without adapter continuation data.
			return yield* Schema.decodeEffect(TurnTranscript)({
				submissionId: submission.id,
				messages: [...history.slice(context.length), decision],
			});
		}

		const { continuation: _continuation, ...call } = decision;
		const result = yield* journal.checkpoint(`tool:${index}`, ToolResult, (attempt) =>
			tools.execute(call, attempt),
		);
		history.push(decision, { role: "tool", callId: call.id, result });
	}
});
