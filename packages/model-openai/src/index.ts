import { toolResultContent, TurnModel, TurnModelError } from "@trajan/harness";
import type { TurnModelEvent } from "@trajan/harness";
import { Effect, Schema, Stream } from "effect";
import { decode as decodeSse } from "effect/encoding/Sse";

const Item = Schema.StructWithRest(Schema.Struct({ type: Schema.NonEmptyString }), [
	Schema.JsonObject,
]);
const Items = Schema.Array(Item);
type Item = typeof Item.Type;
const Event = Schema.fromJsonString(Item);
const Completed = Schema.Struct({ output: Items });
const Call = Schema.Struct({
	call_id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	arguments: Schema.fromJsonString(Schema.JsonObject),
});
const OutputText = Schema.Struct({
	type: Schema.Literal("output_text"),
	text: Schema.String,
});
const isOutputText = Schema.is(OutputText);
const isOutputMessage = Schema.is(
	Schema.Struct({
		type: Schema.Literal("message"),
		id: Schema.optionalKey(Schema.NonEmptyString),
		phase: Schema.optionalKey(Schema.NullOr(Schema.String)),
		content: Items,
	}),
);
const isCompaction = Schema.is(
	Schema.Struct({
		type: Schema.Literal("compaction"),
		encrypted_content: Schema.NonEmptyString,
	}),
);
const UpstreamError = Schema.Struct({
	error: Schema.optionalKey(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
	incomplete_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
});
const AddedItemEvent = Schema.Struct({
	type: Schema.Literal("response.output_item.added"),
	item: Item,
});
const TextDeltaEvent = Schema.Struct({
	type: Schema.Literal("response.output_text.delta"),
	item_id: Schema.NonEmptyString,
	delta: Schema.String,
});
const CompletedEvent = Schema.Struct({
	type: Schema.Literal("response.completed"),
	response: Completed,
});
const UnsuccessfulEvent = Schema.Struct({
	type: Schema.Literals(["response.failed", "response.incomplete"]),
	response: UpstreamError,
});
const ErrorEvent = Schema.Struct({ type: Schema.Literal("error"), message: Schema.String });
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(UpstreamError));
type History = Parameters<TurnModel["Service"]["stream"]>[0];
type Tool = {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
};
type RuntimeLabels = {
	readonly outcome: string;
	readonly uncertainEffects: string;
};
type OpenAiTurnOptions = {
	readonly model: string;
	readonly reasoningEffort: string;
	readonly compactThreshold: number;
	readonly instructions: string;
	readonly runtimeLabels: RuntimeLabels;
	readonly tool: Tool;
};

function requestBody(
	{ model, reasoningEffort, compactThreshold, instructions, tool }: OpenAiTurnOptions,
	input: ReadonlyArray<Item>,
	allowTools: boolean,
) {
	return {
		model,
		instructions,
		input,
		store: false,
		stream: true,
		reasoning: { effort: reasoningEffort },
		include: ["reasoning.encrypted_content"],
		context_management: [{ type: "compaction", compact_threshold: compactThreshold }],
		tools: [{ type: "function", ...tool, strict: true }],
		tool_choice: allowTools ? "auto" : "none",
		parallel_tool_calls: false,
	} as const;
}

export type OpenAiResponsesTransport = (
	body: ReturnType<typeof requestBody>,
	/** Keep using this signal while the response body is being consumed. */
	signal: AbortSignal,
) => Effect.Effect<Response, TurnModelError>;

function modelError(message: string) {
	return new TurnModelError({ message });
}

function transportError(cause: unknown) {
	if (cause instanceof TurnModelError) {
		return cause;
	}
	return new TurnModelError({
		message: cause instanceof Error ? cause.message : "OpenAI request failed.",
		cause,
	});
}

type FunctionToolResult = Extract<History[number], { role: "tool" }>["result"];

function scriptOutput(result: FunctionToolResult) {
	if (result.status !== "completed") {
		return JSON.stringify({ status: result.status, message: result.message });
	}
	const output = toolResultContent(result);
	if (output.type === "json") {
		return JSON.stringify(output.value);
	}
	return output.parts.map((part): Schema.Json =>
		part.type === "image"
			? {
					type: "input_image",
					image_url: `data:${part.mimeType};base64,${part.data}`,
					detail: "auto",
				}
			: { type: "input_text", text: part.text },
	);
}

function toolOutput(result: FunctionToolResult, uncertainEffectsLabel: string) {
	const output = scriptOutput(result);
	if (!result.uncertainEffects?.length) {
		return output;
	}
	return [
		{
			type: "input_text",
			text: `${uncertainEffectsLabel}\n${JSON.stringify(result.uncertainEffects.map(({ name, message }) => ({ name, message })))}`,
		},
		...(typeof output === "string" ? [{ type: "input_text", text: output }] : output),
	];
}

function compactWindow(items: ReadonlyArray<Item>) {
	const pending = new Set<Schema.Json>();
	let start = 0;
	for (const [index, item] of items.entries()) {
		if (item.type === "function_call" && item.call_id !== undefined) {
			pending.add(item.call_id);
		} else if (item.type === "function_call_output" && item.call_id !== undefined) {
			pending.delete(item.call_id);
		} else if (pending.size === 0 && isCompaction(item)) {
			// A cut between a call and its output would orphan the output on replay.
			start = index;
		}
	}
	return items.slice(start);
}

const buildInput = Effect.fnUntraced(function* (
	history: History,
	labels: RuntimeLabels,
	modelContext?: Schema.Json,
) {
	let items = [...(yield* Schema.decodeUnknownEffect(Items)(modelContext ?? []))];
	for (const message of history) {
		switch (message.role) {
			case "user":
			case "assistant":
				items.push({ type: "message", role: message.role, content: message.text });
				break;
			case "runtime-outcome":
				items.push({
					type: "message",
					role: "user",
					content: `${labels.outcome}\n${JSON.stringify(message)}`,
				});
				break;
			case "tool-call": {
				const output = yield* Schema.decodeUnknownEffect(Items)(message.continuation);
				if (!output.some((item) => item.type === "function_call" && item.call_id === message.id)) {
					return yield* modelError("Checkpointed OpenAI tool call is missing its response items.");
				}
				items.push(...output);
				break;
			}
			case "tool":
				items.push({
					type: "function_call_output",
					call_id: message.callId,
					output: toolOutput(message.result, labels.uncertainEffects),
				});
				items = compactWindow(items);
				break;
		}
	}
	return items;
}, Effect.mapError(transportError));

const completedResponse = Effect.fnUntraced(function* (
	output: ReadonlyArray<Item>,
	input: ReadonlyArray<Item>,
	tool: Tool,
	allowTools: boolean,
) {
	const calls = output.filter((item) => item.type === "function_call");
	if (calls.length > 0) {
		if (!allowTools || calls.length !== 1) {
			return yield* modelError("Expected a single OpenAI call to the declared tool.");
		}
		const call = yield* Schema.decodeUnknownEffect(Call)(calls[0]);
		if (call.name !== tool.name) {
			return yield* modelError("OpenAI called an undeclared tool.");
		}
		return {
			role: "tool-call" as const,
			id: call.call_id,
			name: call.name,
			input: call.arguments,
			continuation: output,
		};
	}

	const text = output
		.filter(isOutputMessage)
		.filter(({ phase }) => phase !== "commentary")
		.flatMap(({ content }) => content.filter(isOutputText).map(({ text }) => text))
		.join("")
		.trim();
	if (!text) {
		return yield* modelError("OpenAI returned an empty final reply.");
	}
	return {
		role: "assistant" as const,
		text,
		continuation: compactWindow([...input, ...output]),
	};
});

const readEvent = Effect.fnUntraced(function* (
	event: Item,
	commentary: Set<string>,
	input: ReadonlyArray<Item>,
	tool: Tool,
	allowTools: boolean,
): Effect.fn.Return<TurnModelEvent | undefined, TurnModelError | Schema.SchemaError> {
	switch (event.type) {
		case "response.output_item.added": {
			const { item } = yield* Schema.decodeUnknownEffect(AddedItemEvent)(event);
			if (isOutputMessage(item) && item.phase === "commentary" && item.id !== undefined) {
				commentary.add(item.id);
			}
			return;
		}
		case "response.output_text.delta": {
			const { item_id, delta } = yield* Schema.decodeUnknownEffect(TextDeltaEvent)(event);
			return commentary.has(item_id) ? undefined : { type: "text-delta", text: delta };
		}
		case "response.completed": {
			const {
				response: { output },
			} = yield* Schema.decodeUnknownEffect(CompletedEvent)(event);
			return {
				type: "response",
				response: yield* completedResponse(output, input, tool, allowTools),
			};
		}
		case "response.failed":
		case "response.incomplete": {
			const { response } = yield* Schema.decodeUnknownEffect(UnsuccessfulEvent)(event);
			const message = response.error?.message ?? response.incomplete_details?.reason;
			return yield* modelError(message ?? `OpenAI stream ended with ${event.type}.`);
		}
		case "error": {
			const { message } = yield* Schema.decodeUnknownEffect(ErrorEvent)(event);
			return yield* modelError(message);
		}
		default:
			return undefined;
	}
});

export function openAiTurnModel(request: OpenAiResponsesTransport, options: OpenAiTurnOptions) {
	const { runtimeLabels, tool } = options;
	const openStream = Effect.fn("model-openai.openStream")(function* (
		history: History,
		{ allowTools, modelContext }: Parameters<TurnModel["Service"]["stream"]>[1],
	) {
		const input = yield* buildInput(history, runtimeLabels, modelContext);
		const controller = yield* Effect.acquireRelease(
			Effect.sync(() => new AbortController()),
			(activeRequest) => Effect.sync(() => activeRequest.abort()),
		);
		const response = yield* request(
			requestBody(options, input, allowTools),
			controller.signal,
		).pipe(
			Effect.timeoutOrElse({
				duration: "30 seconds",
				orElse: () => Effect.fail(modelError("Timed out waiting for OpenAI response headers.")),
			}),
		);
		if (!response.ok) {
			const body = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: transportError,
			}).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed("") }));
			const decoded = decodeErrorBody(body);
			const detail = decoded._tag === "Some" ? decoded.value.error?.message : undefined;
			return yield* modelError(
				detail ?? `OpenAI Responses request returned HTTP ${response.status}.`,
			);
		}
		const body = response.body;
		if (!body || !response.headers.get("content-type")?.includes("text/event-stream")) {
			return yield* modelError("Expected an OpenAI Responses event stream.");
		}

		const commentary = new Set<string>();
		return Stream.fromReadableStream({ evaluate: () => body, onError: transportError }).pipe(
			Stream.decodeText(),
			Stream.pipeThroughChannel(decodeSse()),
			Stream.timeoutOrElse({
				duration: "90 seconds",
				orElse: () => Stream.fail(modelError("The OpenAI response stream stopped sending events.")),
			}),
			Stream.filter((event) => event.data !== "[DONE]"),
			Stream.mapEffect(({ data }) => Schema.decodeEffect(Event)(data)),
			Stream.mapEffect((event) =>
				readEvent(event, commentary, input, tool, allowTools).pipe(
					Effect.mapError((error) =>
						Schema.isSchemaError(error)
							? modelError(`OpenAI returned an invalid ${event.type} event.`)
							: error,
					),
				),
			),
			Stream.filter((event) => event !== undefined),
			Stream.takeUntil((event) => event.type === "response"),
			Stream.mapError(transportError),
		);
	});
	return TurnModel.of({
		contextFormat: { adapter: "openai-responses", version: 1 },
		contextSchema: Items,
		stream: (history, options) => Stream.unwrap(openStream(history, options)),
	});
}
