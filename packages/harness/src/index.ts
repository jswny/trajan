import { Context, Effect, Option, Schema, Stream } from "effect";

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

export const toolPreviewBytes = 3 * 1024;
export const fileDiffBytes = 8 * 1024;
export const FileChange = Schema.Struct({
	path: Schema.NonEmptyString,
	kind: Schema.Literals(["added", "modified", "unchanged"]),
	diff: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(fileDiffBytes))),
});
const toolPreviewFields = {
	text: Schema.String.check(Schema.isMaxLength(toolPreviewBytes)),
	truncated: Schema.Boolean,
};
export const FilePreview = Schema.Struct({
	format: Schema.Literal("file"),
	path: Schema.NonEmptyString,
	...toolPreviewFields,
});
export const ToolActivityPreview = Schema.Union([
	Schema.Struct({ format: Schema.Literals(["json", "text"]), ...toolPreviewFields }),
	FilePreview,
]);
export const ToolActivity = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	status: Schema.Literals(["running", "completed", "failed", "interrupted"]),
	input: Schema.optionalKey(ToolActivityPreview),
	output: Schema.optionalKey(ToolActivityPreview),
	fileChange: Schema.optionalKey(FileChange),
});
const EffectSummary = Schema.Struct({
	name: ToolActivity.fields.name,
	message: Schema.NonEmptyString.check(Schema.isMaxLength(toolPreviewBytes)),
});
export const UncertainToolEffect = Schema.Struct({
	id: ToolActivity.fields.id,
	...EffectSummary.fields,
});
const toolActivityFields = {
	activity: Schema.optionalKey(Schema.Array(ToolActivity)),
	uncertainEffects: Schema.optionalKey(Schema.Array(UncertainToolEffect)),
};
export const ToolContent = Schema.Array(
	Schema.Union([
		Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
		Schema.Struct({
			type: Schema.Literal("image"),
			mimeType: Schema.Literals(["image/jpeg", "image/png", "image/webp", "image/gif"]),
			data: Schema.NonEmptyString,
		}),
	]),
);
export const ToolResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("completed"),
		output: Schema.Json,
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
export const TurnMessage = Schema.Union([UserMessage, Reply, ToolCall, ToolMessage, TurnNotice]);
export const ConversationMessage = Schema.Union([UserMessage, Reply]);
export const RuntimeOutcome = Schema.Struct({
	role: Schema.Literal("runtime-outcome"),
	status: TurnNotice.fields.status,
	text: Schema.String,
	request: Schema.String,
	uncertainEffects: Schema.optionalKey(Schema.Array(EffectSummary)),
	tools: Schema.Array(
		Schema.Struct({
			name: ToolActivity.fields.name,
			status: ToolActivity.fields.status,
			path: Schema.optionalKey(FileChange.fields.path),
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

export const SavedModelContext = Schema.Struct({
	...ModelContextFormat.fields,
	state: Schema.Json,
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
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

type TurnError = TurnIoError | TurnModelError | Schema.SchemaError;

export interface StepAttempt {
	readonly runId: string;
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
		/** Identifies the format of the opaque context this adapter reads and writes. */
		readonly contextFormat: typeof ModelContextFormat.Type;
		readonly stream: (
			messages: ReadonlyArray<ModelContextEntry | TurnHistoryEntry>,
			options: { readonly allowTools: boolean; readonly modelContext?: Schema.Json },
		) => Stream.Stream<TurnModelEvent, TurnModelError>;
	}
>()("@trajan/harness/TurnModel") {}

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

/** Run a turn until the model replies, with a checkpoint for each decision and tool result. */
export const runTurn = Effect.fn("harness.runTurn")(function* (
	submission: typeof TurnSubmission.Type,
	journal: TurnJournal,
	context: ReadonlyArray<ModelContextEntry> = [],
	publish: (event: TurnProgress) => Effect.Effect<void> = () => Effect.void,
	modelContext?: Schema.Json,
) {
	const model = yield* TurnModel;
	const tools = yield* TurnTools;
	const history: Array<TurnHistoryEntry> = [{ role: "user", text: submission.prompt }];

	for (let index = 0; ; index++) {
		const allowTools = index < MAX_TOOL_CALLS;
		const decision = yield* journal.checkpoint(
			`model:${index}`,
			allowTools ? ModelResponse : ModelReply,
			() =>
				Effect.gen(function* () {
					yield* publish({ type: "reset" });
					const last = yield* model
						.stream([...context, ...history], {
							allowTools,
							...(modelContext !== undefined && { modelContext }),
						})
						.pipe(
							Stream.tap((event) => (event.type === "text-delta" ? publish(event) : Effect.void)),
							Stream.runLast,
						);
					if (Option.isNone(last) || last.value.type !== "response") {
						return yield* new TurnModelError({
							message: "The model stream ended without a response.",
						});
					}
					return last.value.response;
				}).pipe(Effect.tapError(() => publish({ type: "reset" }))),
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
		const result = yield* journal.checkpoint(`tool:${index}`, ToolResult, (attempt) =>
			publish({ type: "tool", call }).pipe(
				Effect.andThen(
					tools.execute(call, attempt, (activity) =>
						publish({ type: "tool-activity", callId: call.id, activity }),
					),
				),
			),
		);
		yield* publish({ type: "tool-result", call, result });
		history.push(decision, { role: "tool", callId: call.id, result });
	}
});
