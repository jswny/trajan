import { Cause, Context, Effect, Option, Schema, Stream } from "effect";

export const TurnPrompt = Schema.NonEmptyString.check(
	Schema.isMaxLength(32_000),
	Schema.isTrimmed(),
);
export const TurnSubmission = Schema.Struct({
	id: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
	prompt: TurnPrompt,
});

const UserMessage = Schema.Struct({
	role: Schema.Literal("user"),
	text: Schema.NonEmptyString,
});

const Reply = Schema.Struct({
	role: Schema.Literal("assistant"),
	text: Schema.NonEmptyString,
});

export const ToolCall = Schema.Struct({
	role: Schema.Literal("tool-call"),
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	input: Schema.Json,
});

export const ToolActivityIdentity = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	status: Schema.Literals(["running", "completed", "failed", "interrupted"]),
});
export const ToolActivity = Schema.StructWithRest(ToolActivityIdentity, [
	Schema.Record(Schema.String, Schema.Json),
]);
const EffectSummary = Schema.Struct({
	name: ToolActivityIdentity.fields.name,
	message: Schema.NonEmptyString.check(Schema.isMaxLength(3 * 1024)),
});
export const UncertainToolEffect = Schema.Struct({
	id: ToolActivityIdentity.fields.id,
	...EffectSummary.fields,
});
const toolActivityFields = {
	activity: Schema.optionalKey(Schema.Array(ToolActivity)),
	uncertainEffects: Schema.optionalKey(Schema.Array(UncertainToolEffect)),
};
export const ToolContentPart = Schema.Union([
	Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
	Schema.Struct({
		type: Schema.Literal("image"),
		mimeType: Schema.Literals(["image/jpeg", "image/png", "image/webp", "image/gif"]),
		data: Schema.NonEmptyString,
	}),
]);
export const ToolContent = Schema.NonEmptyArray(ToolContentPart);
const RichToolOutput = Schema.Struct({
	type: Schema.Literal("tool-content"),
	parts: ToolContent,
});
const legacyContent = Schema.decodeUnknownOption(ToolContent);
const richContent = Schema.decodeUnknownOption(RichToolOutput);

export const ToolResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("completed"),
		output: Schema.Json,
		outputFormat: Schema.optionalKey(Schema.Literal("json")),
		...toolActivityFields,
	}),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		...toolActivityFields,
	}),
	Schema.Struct({
		status: Schema.Literal("unknown"),
		message: Schema.String,
		...toolActivityFields,
	}),
]);

export function completedToolResult(output: Schema.Json) {
	return {
		status: "completed" as const,
		output,
		...(Option.isSome(legacyContent(output)) && { outputFormat: "json" as const }),
	};
}

export function toolResultContent(
	result: Extract<typeof ToolResult.Type, { status: "completed" }>,
) {
	const { output, outputFormat } = result;
	if (outputFormat === "json") {
		return { type: "json" as const, value: output };
	}
	const rich = richContent(output);
	const content = Option.isSome(rich) ? Option.some(rich.value.parts) : legacyContent(output);
	return Option.isSome(content)
		? { type: "content" as const, parts: content.value }
		: { type: "json" as const, value: output };
}

const ToolMessage = Schema.Struct({
	role: Schema.Literal("tool"),
	callId: Schema.NonEmptyString,
	result: ToolResult,
});

const TurnNotice = Schema.Struct({
	role: Schema.Literal("notice"),
	status: Schema.Literals(["failed", "cancelled"]),
	text: Schema.NonEmptyString,
});
export const InterruptedReply = Schema.Struct({
	role: Schema.Literal("interrupted"),
	attemptId: Schema.NonEmptyString,
	text: Schema.NonEmptyString,
	truncated: Schema.Boolean,
});
export const TurnMessage = Schema.Union([
	UserMessage,
	Reply,
	InterruptedReply,
	ToolCall,
	ToolMessage,
	TurnNotice,
]);
export const ConversationMessage = Schema.Union([UserMessage, Reply]);
export const RuntimeOutcome = Schema.Struct({
	role: Schema.Literal("runtime-outcome"),
	status: TurnNotice.fields.status,
	text: Schema.String,
	request: Schema.String,
	uncertainEffects: Schema.optionalKey(Schema.Array(EffectSummary)),
	tools: Schema.Array(
		Schema.Struct({
			name: ToolActivityIdentity.fields.name,
			status: ToolActivityIdentity.fields.status,
			path: Schema.optionalKey(Schema.NonEmptyString),
		}),
	),
});
const ModelToolCall = Schema.Struct({
	...ToolCall.fields,
	// Adapter context belongs to the checkpointed model response.
	continuation: Schema.optionalKey(Schema.Json),
});
const ModelReply = Schema.Struct({
	...Reply.fields,
	continuation: Schema.optionalKey(Schema.Json),
});
const ModelResponse = Schema.Union([ModelReply, ModelToolCall]);
export type TurnModelResponse = typeof ModelResponse.Type;

type TurnHistoryEntry =
	| typeof UserMessage.Type
	| typeof ModelToolCall.Type
	| typeof ToolMessage.Type;
type ModelContextEntry = typeof ConversationMessage.Type | typeof RuntimeOutcome.Type;
const MAX_TOOL_CALLS = 8;

export const TurnTranscript = Schema.Struct({
	submissionId: Schema.NonEmptyString,
	messages: Schema.Array(TurnMessage),
});

const ModelContextFormat = Schema.Struct({
	adapter: Schema.NonEmptyString,
	version: Schema.Int.check(Schema.isGreaterThan(0)),
});

// Bound UTF-16 units conservatively so UTF-8 and checkpoint encoding fit storage.
const modelContextJsonLimit = 2 * 1024 * 1024;
export const ModelContextState = Schema.Json.check(
	Schema.makeFilter(
		(state) =>
			JSON.stringify(state).length <= modelContextJsonLimit ||
			"Model context exceeds the persistence budget.",
	),
);

export const SavedModelContext = Schema.Struct({
	...ModelContextFormat.fields,
	state: ModelContextState,
});

export type TurnCompletion = typeof TurnTranscript.Type & {
	readonly modelContext?: typeof SavedModelContext.Type;
};

export class TurnIoError extends Schema.TaggedError<
	TurnIoError,
	{ readonly brand: unique symbol }
>()("TurnIoError", {
	operation: Schema.String,
	cause: Schema.Defect(),
	message: Schema.optionalKey(Schema.String),
}) {}

export class TurnModelError extends Schema.TaggedError<
	TurnModelError,
	{ readonly brand: unique symbol }
>()("TurnModelError", {
	message: Schema.String,
	retryable: Schema.Boolean,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

type TurnError = TurnIoError | TurnModelError | Schema.SchemaError;

export interface StepAttempt {
	readonly runId: string;
	readonly idempotencyKey: string;
	/** An earlier attempt may have started this step's external work. */
	readonly recovering: boolean;
	readonly recordText?: (delta: string) => Effect.Effect<void>;
}

/** Names are stable journal keys across attempts of a turn. */
export type TurnCheckpoint =
	| { readonly kind: "model"; readonly name: string; readonly nextTool: string }
	| { readonly kind: "tool"; readonly name: string };

export interface TurnJournal {
	/** Save one result per step name and return it on subsequent executions. */
	readonly checkpoint: <A extends Schema.Json>(
		checkpoint: TurnCheckpoint,
		result: Schema.Codec<A>,
		run: (attempt: StepAttempt) => Effect.Effect<unknown, TurnError>,
	) => Effect.Effect<A, TurnError>;
}

export class TurnModel extends Context.Service<
	TurnModel,
	{
		/** Identifies the format of the opaque context this adapter reads and writes. */
		readonly contextFormat: typeof ModelContextFormat.Type;
		readonly contextSchema: Schema.Codec<Schema.Json>;
		readonly stream: (
			messages: ReadonlyArray<ModelContextEntry | TurnHistoryEntry>,
			options: { readonly allowTools: boolean; readonly modelContext?: Schema.Json },
		) => Stream.Stream<TurnModelEvent, TurnModelError>;
	}
>()("@trajan/harness/TurnModel") {}

export function restoreModelContext(
	model: Pick<TurnModel["Service"], "contextFormat" | "contextSchema">,
	saved: typeof SavedModelContext.Type | undefined,
): Option.Option<Schema.Json> {
	if (
		saved?.adapter === model.contextFormat.adapter &&
		saved.version === model.contextFormat.version &&
		Schema.is(model.contextSchema)(saved.state)
	) {
		return Option.some(saved.state);
	}
	return Option.none();
}

export type TurnModelEvent =
	| { readonly type: "text-delta"; readonly text: string }
	| { readonly type: "response"; readonly response: TurnModelResponse };

export type TurnProgress =
	| Extract<TurnModelEvent, { type: "text-delta" }>
	| { type: "reset" }
	| { type: "tool"; call: typeof ToolCall.Type }
	| { type: "tool-activity"; callId: string; activity: ReadonlyArray<typeof ToolActivity.Type> }
	| { type: "tool-result"; call: typeof ToolCall.Type; result: typeof ToolResult.Type };

export class TurnTools extends Context.Service<
	TurnTools,
	{
		readonly execute: (
			call: typeof ToolCall.Type,
			attempt: StepAttempt,
			publishActivity: (activity: ReadonlyArray<typeof ToolActivity.Type>) => Effect.Effect<void>,
		) => Effect.Effect<typeof ToolResult.Type, TurnError>;
	}
>()("@trajan/harness/TurnTools") {}

/** Live updates can fail independently of the work and its checkpoints. */
export function publishUpdate<E>(event: string, send: () => Effect.Effect<void, E>) {
	return Effect.suspend(send).pipe(
		Effect.catchCauseIf(
			(cause) => !Cause.hasInterruptsOnly(cause),
			(cause) =>
				Effect.logWarning("Live update failed", cause).pipe(Effect.annotateLogs({ event })),
		),
	);
}

/** Run a turn until the model replies, with a checkpoint for each decision and tool result. */
export const runTurn = Effect.fn("harness.runTurn")(function* (
	submission: typeof TurnSubmission.Type,
	journal: TurnJournal,
	context: ReadonlyArray<ModelContextEntry> = [],
	publish: (event: TurnProgress) => Effect.Effect<void> = () => Effect.void,
	modelContext?: Schema.Json,
) {
	const notify = (event: TurnProgress) => publishUpdate(event.type, () => publish(event));
	const model = yield* TurnModel;
	const tools = yield* TurnTools;
	const history: Array<TurnHistoryEntry> = [{ role: "user", text: submission.prompt }];

	for (let index = 0; ; index++) {
		const allowTools = index < MAX_TOOL_CALLS;
		const toolStep = { kind: "tool", name: `tool:${index}` } as const;
		const decision = yield* journal.checkpoint(
			{ kind: "model", name: `model:${index}`, nextTool: toolStep.name },
			allowTools ? ModelResponse : ModelReply,
			({ recordText }) =>
				Effect.gen(function* () {
					yield* notify({ type: "reset" });
					const last = yield* model
						.stream([...context, ...history], {
							allowTools,
							...(modelContext !== undefined && { modelContext }),
						})
						.pipe(
							Stream.tap((event) =>
								event.type === "text-delta"
									? (recordText?.(event.text) ?? Effect.void).pipe(Effect.andThen(notify(event)))
									: Effect.void,
							),
							Stream.runLast,
						);
					if (Option.isNone(last) || last.value.type !== "response") {
						return yield* new TurnModelError({
							message: "The model stream ended without a response.",
							retryable: true,
						});
					}
					const { response } = last.value;
					if (
						response.role === "assistant" &&
						response.continuation !== undefined &&
						!Schema.is(ModelContextState)(response.continuation)
					) {
						yield* Effect.logWarning("Discarded an oversized model continuation");
						return { role: response.role, text: response.text };
					}
					return response;
				}),
		);

		if (decision.role === "assistant") {
			// Project the transcript without adapter continuation data.
			const transcript = yield* Schema.decodeEffect(TurnTranscript)({
				submissionId: submission.id,
				messages: [...history, decision],
			});
			return {
				...transcript,
				...(decision.continuation !== undefined && {
					modelContext: { ...model.contextFormat, state: decision.continuation },
				}),
			} satisfies TurnCompletion;
		}

		const { continuation: _continuation, ...call } = decision;
		const result = yield* journal.checkpoint(toolStep, ToolResult, (attempt) =>
			notify({ type: "tool", call }).pipe(
				Effect.andThen(
					tools.execute(call, attempt, (activity) =>
						notify({ type: "tool-activity", callId: call.id, activity }),
					),
				),
			),
		);
		yield* notify({ type: "tool-result", call, result });
		history.push(decision, { role: "tool", callId: call.id, result });
	}
});
