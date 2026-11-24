import type { AssistantMessage, Message, Tool, Usage } from "@earendil-works/pi-ai";
import { TurnModel, TurnModelError } from "@trajan/effect-harness";
import type { TurnModelEvent } from "@trajan/effect-harness";
import { createAI } from "agents/models/pi-ai";
import { Clock, Effect, Schema, Stream } from "effect";
import { MODEL_ID } from "../model-id";

const AssistantContext = Schema.Array(
	Schema.Union([
		Schema.Struct({
			type: Schema.Literal("text"),
			text: Schema.String,
			textSignature: Schema.optionalKey(Schema.String),
		}),
		Schema.Struct({
			type: Schema.Literal("thinking"),
			thinking: Schema.String,
			thinkingSignature: Schema.optionalKey(Schema.String),
			redacted: Schema.optionalKey(Schema.Boolean),
		}),
	]),
);

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function modelFailure(cause: unknown): TurnModelError {
	const message =
		cause instanceof Error
			? cause.message
			: typeof cause === "string"
				? cause
				: "Workers AI inference failed.";
	return new TurnModelError({ cause, message });
}

const modelResponse = Effect.fnUntraced(function* (
	response: AssistantMessage,
	tool: Tool,
	allowTools: boolean,
) {
	if (response.stopReason === "stop") {
		const text = response.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		if (text.trim()) {
			return { role: "assistant", text };
		}
		return yield* modelFailure("The model returned an empty reply.");
	}

	if (response.stopReason === "toolUse" && allowTools) {
		const calls = response.content.filter((part) => part.type === "toolCall");
		const [next] = calls;
		if (calls.length === 1 && tool.name === next.name && !next.argumentsError) {
			return {
				role: "tool-call",
				id: next.id,
				name: next.name,
				input: next.arguments,
				continuation: response.content.filter((part) => part.type !== "toolCall"),
			};
		}
		return yield* modelFailure("Expected one valid call to the declared tool.");
	}

	return yield* modelFailure(response.errorMessage ?? `Model stopped with ${response.stopReason}.`);
});

export function workersAiTurnModel(binding: Env["AI"], tool: Tool, systemPrompt?: string) {
	const ai = createAI({ binding });
	const model = ai(MODEL_ID);
	const openStream = Effect.fn("effect-harness.workersAi.openStream")(function* (
		messages: Parameters<TurnModel["Service"]["stream"]>[0],
		allowTools: boolean,
	) {
		const timestamp = yield* Clock.currentTimeMillis;
		const context: Array<Message> = [];
		let pendingCall: { id: string; name: string } | undefined;

		for (const message of messages) {
			switch (message.role) {
				case "user":
					context.push({ role: "user", content: message.text, timestamp });
					break;
				case "assistant":
					context.push({
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [{ type: "text", text: message.text }],
						stopReason: "stop",
						usage: emptyUsage,
						timestamp,
					});
					break;
				case "tool-call": {
					// Each tool request carries its own DeepSeek reasoning history.
					const content = yield* Schema.decodeUnknownEffect(AssistantContext)(
						message.continuation,
					).pipe(Effect.mapError(modelFailure));
					const args = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(message.input).pipe(
						Effect.mapError(modelFailure),
					);
					context.push({
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [
							...content,
							{ type: "toolCall", id: message.id, name: message.name, arguments: args },
						],
						stopReason: "toolUse",
						usage: emptyUsage,
						timestamp,
					});
					pendingCall = { id: message.id, name: message.name };
					break;
				}
				case "tool": {
					if (pendingCall?.id !== message.callId) {
						return yield* modelFailure("The tool result did not match the preceding tool call.");
					}
					const result = message.result;
					context.push({
						role: "toolResult",
						toolCallId: message.callId,
						toolName: pendingCall.name,
						content: [
							{
								type: "text",
								text:
									result.status === "completed" ? JSON.stringify(result.output) : result.message,
							},
						],
						isError: result.status !== "completed",
						timestamp,
					});
					pendingCall = undefined;
					break;
				}
			}
		}

		const controller = yield* Effect.acquireRelease(
			Effect.sync(() => new AbortController()),
			(controller) => Effect.sync(() => controller.abort()),
		);
		const events = yield* Effect.try({
			try: () =>
				ai.streamSimple(
					model,
					{ messages: context, tools: allowTools ? [tool] : [], systemPrompt },
					{
						reasoning: "low",
						toolChoice: allowTools ? "auto" : "none",
						samplingParams: { parallel_tool_calls: false },
						signal: controller.signal,
					},
				),
			catch: modelFailure,
		});

		return Stream.fromAsyncIterable(events, modelFailure).pipe(
			Stream.flatMap((event): Stream.Stream<TurnModelEvent, TurnModelError> => {
				switch (event.type) {
					case "text_delta":
						return Stream.succeed({ type: "text-delta", text: event.delta });
					case "done":
						return modelResponse(event.message, tool, allowTools).pipe(
							Effect.map((response) => ({ type: "response" as const, response })),
							Stream.fromEffect,
						);
					case "error":
						return Stream.fail(
							modelFailure(event.error.errorMessage ?? `Model stopped with ${event.reason}.`),
						);
					default:
						return Stream.empty;
				}
			}),
		);
	});
	return TurnModel.of({
		stream: (messages, { allowTools }) => Stream.unwrap(openStream(messages, allowTools)),
	});
}
