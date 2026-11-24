import { TurnModel, TurnModelError } from "@trajan/harness";
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
	error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
	incomplete_details: Schema.optionalKey(Schema.Struct({ reason: Schema.String })),
});
const decodeUpstreamError = Schema.decodeUnknownOption(UpstreamError);
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(UpstreamError));
type History = Parameters<TurnModel["Service"]["stream"]>[0];
type Tool = {
	readonly name: string;
	readonly description: string;
	readonly parameters: object;
};
type OpenAiTurnOptions = {
	readonly model: string;
	readonly reasoningEffort: string;
	readonly compactThreshold: number;
	readonly instructions: string;
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
	signal: AbortSignal,
) => Promise<Response>;

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

const buildInput = Effect.fnUntraced(function* (history: History, modelContext?: Schema.Json) {
	let items = [...(yield* Schema.decodeUnknownEffect(Items)(modelContext ?? []))];
	for (const message of history) {
		switch (message.role) {
			case "user":
			case "assistant":
				items.push({ type: "message", role: message.role, content: message.text });
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
					output: JSON.stringify(
						message.result.status === "completed"
							? message.result.output
							: { status: message.result.status, message: message.result.message },
					),
				});
				items = compactWindow(items);
				break;
		}
	}
	return items;
}, Effect.mapError(transportError));

const completedResponse = Effect.fnUntraced(function* (
	response: Schema.Json | undefined,
	input: ReadonlyArray<Item>,
	tool: Tool,
	allowTools: boolean,
) {
	const { output } = yield* Schema.decodeUnknownEffect(Completed)(response);
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
}, Effect.mapError(transportError));

export function openAiTurnModel(request: OpenAiResponsesTransport, options: OpenAiTurnOptions) {
	const { tool } = options;
	const openStream = Effect.fn("model-openai.openStream")(function* (
		history: History,
		{ allowTools, modelContext }: Parameters<TurnModel["Service"]["stream"]>[1],
	) {
		const input = yield* buildInput(history, modelContext);
		const controller = yield* Effect.acquireRelease(
			Effect.sync(() => new AbortController()),
			(activeRequest) => Effect.sync(() => activeRequest.abort()),
		);
		const response = yield* Effect.tryPromise({
			try: () => request(requestBody(options, input, allowTools), controller.signal),
			catch: transportError,
		});
		if (!response.ok) {
			const body = yield* Effect.tryPromise({ try: () => response.text(), catch: transportError });
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

		return Stream.fromReadableStream({ evaluate: () => body, onError: transportError }).pipe(
			Stream.decodeText(),
			Stream.pipeThroughChannel(decodeSse()),
			Stream.filter((event) => event.data !== "[DONE]"),
			Stream.mapEffect(({ data }) => Schema.decodeEffect(Event)(data)),
			Stream.flatMap((event): Stream.Stream<TurnModelEvent, TurnModelError> => {
				switch (event.type) {
					case "response.output_text.delta":
						return typeof event.delta === "string"
							? Stream.succeed({ type: "text-delta", text: event.delta })
							: Stream.fail(modelError("OpenAI returned an invalid text delta."));
					case "response.completed":
						return completedResponse(event.response, input, tool, allowTools).pipe(
							Effect.map((result) => ({ type: "response" as const, response: result })),
							Stream.fromEffect,
						);
					case "response.failed":
					case "response.incomplete":
					case "error": {
						const decoded = decodeUpstreamError(event.response ?? { error: event });
						const message =
							decoded._tag === "Some"
								? (decoded.value.error?.message ?? decoded.value.incomplete_details?.reason)
								: undefined;
						return Stream.fail(modelError(message ?? `OpenAI stream ended with ${event.type}.`));
					}
					default:
						return Stream.empty;
				}
			}),
			Stream.takeUntil((event) => event.type === "response"),
			Stream.mapError(transportError),
		);
	});
	return TurnModel.of({
		contextFormat: { adapter: "openai-responses", version: 1 },
		stream: (history, options) => Stream.unwrap(openStream(history, options)),
	});
}
