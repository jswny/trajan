import { Context, Data, Effect, Schema } from "effect";

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

const ToolResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Json }),
	Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
	Schema.Struct({ status: Schema.Literal("unknown"), message: Schema.String }),
]);

const ToolMessage = Schema.Struct({
	role: Schema.Literal("tool"),
	callId: Schema.NonEmptyString,
	result: ToolResult,
});

const Message = Schema.Union([UserMessage, Reply, ToolCall, ToolMessage]);
const ModelResponse = Schema.Union([
	Reply,
	Schema.Struct({ ...ToolCall.fields, continuation: Schema.optionalKey(Schema.Json) }),
]);

export const TurnTranscript = Schema.Struct({
	submissionId: Schema.NonEmptyString,
	messages: Schema.Array(Message),
});

export class TurnIoError extends Data.TaggedError("TurnIoError")<{
	readonly operation: string;
	readonly cause: unknown;
	readonly message?: string;
}> {}

type TurnError = TurnIoError | Schema.SchemaError;

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
			messages: ReadonlyArray<typeof Message.Type>,
			/** Adapter context from the checkpointed model response that requested the tool. */
			continuation?: Schema.Json,
		) => Effect.Effect<unknown, TurnIoError>;
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

/** Run one turn through a direct reply or a single tool call followed by a reply. */
export const runTurn = Effect.fn("effect-harness.runTurn")(function* (
	submission: typeof TurnSubmission.Type,
	journal: TurnJournal,
) {
	const model = yield* TurnModel;
	const prompt = { role: "user", text: submission.prompt } satisfies typeof UserMessage.Type;
	const initial = yield* journal.checkpoint("initial-model", ModelResponse, () =>
		model.complete([prompt]),
	);

	if (initial.role === "assistant") {
		return { submissionId: submission.id, messages: [prompt, initial] };
	}

	const { continuation, ...call } = initial;
	const tools = yield* TurnTools;
	const result = yield* journal.checkpoint("tool", ToolResult, (attempt) =>
		tools.execute(call, attempt),
	);
	const toolMessage = {
		role: "tool",
		callId: call.id,
		result,
	} satisfies typeof ToolMessage.Type;
	const history = [prompt, call, toolMessage];
	const reply = yield* journal.checkpoint("final-model", Reply, () =>
		model.complete(history, continuation),
	);

	return { submissionId: submission.id, messages: [...history, reply] };
});
