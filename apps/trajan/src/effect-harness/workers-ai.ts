import type { Message, Tool, Usage } from "@earendil-works/pi-ai";
import { TurnModel, TurnModelError } from "@trajan/effect-harness";
import { createAI } from "agents/models/pi-ai";
import { Clock, Effect, Schema } from "effect";
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

export function workersAiTurnModel(binding: Env["AI"], tool: Tool) {
	const ai = createAI({ binding });
	const model = ai(MODEL_ID);
	return TurnModel.of({
		complete: Effect.fn("effect-harness.workersAi.complete")(function* (messages, { allowTools }) {
			const timestamp = yield* Clock.currentTimeMillis;
			const context: Message[] = [];
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

			const response = yield* Effect.tryPromise({
				try: (signal) =>
					ai.completeSimple(
						model,
						{ messages: context, tools: [tool] },
						{
							reasoning: "low",
							toolChoice: allowTools ? "auto" : "none",
							samplingParams: { parallel_tool_calls: false },
							signal,
						},
					),
				catch: modelFailure,
			});

			if (response.stopReason === "stop") {
				const text = response.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
				if (text.trim()) return { role: "assistant", text };
				return yield* modelFailure("The model returned an empty reply.");
			}

			if (response.stopReason === "toolUse" && allowTools) {
				const calls = response.content.filter((part) => part.type === "toolCall");
				const [next] = calls;
				if (calls.length === 1 && next.name === tool.name && !next.argumentsError) {
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

			return yield* modelFailure(
				response.errorMessage ?? `Model stopped with ${response.stopReason}.`,
			);
		}),
	});
}
