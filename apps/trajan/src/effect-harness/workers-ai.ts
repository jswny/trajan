import type { Message, Tool, Usage } from "@earendil-works/pi-ai";
import { TurnIoError, TurnModel } from "@trajan/effect-harness";
import { createAI } from "agents/models/pi-ai";
import { Effect, Schema } from "effect";
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

function modelFailure(cause: unknown): TurnIoError {
	const message =
		cause instanceof Error
			? cause.message
			: typeof cause === "string"
				? cause
				: "Workers AI inference failed.";
	return new TurnIoError({ operation: "Workers AI inference", cause, message });
}

export function workersAiTurnModel(binding: Env["AI"], tool: Tool) {
	const ai = createAI({ binding });
	const model = ai(MODEL_ID);
	return TurnModel.of({
		complete: (messages, continuation) =>
			Effect.gen(function* () {
				const [user, call, outcome] = messages;
				if (user?.role !== "user") {
					return yield* modelFailure("The turn must start with a user message.");
				}

				const timestamp = Date.now();
				const context: Message[] = [{ role: "user", content: user.text, timestamp }];
				const followUp = call?.role === "tool-call" && outcome?.role === "tool";
				if (followUp) {
					// Carry DeepSeek's reasoning through the tool-result request.
					const content = yield* Schema.decodeUnknownEffect(AssistantContext)(continuation).pipe(
						Effect.mapError(modelFailure),
					);
					const args = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(call.input).pipe(
						Effect.mapError(modelFailure),
					);
					context.push(
						{
							role: "assistant",
							api: model.api,
							provider: model.provider,
							model: model.id,
							content: [
								...content,
								{ type: "toolCall", id: call.id, name: call.name, arguments: args },
							],
							stopReason: "toolUse",
							usage: emptyUsage,
							timestamp,
						},
						{
							role: "toolResult",
							toolCallId: outcome.callId,
							toolName: call.name,
							content: [
								{
									type: "text",
									text:
										outcome.result.status === "completed"
											? JSON.stringify(outcome.result.output)
											: outcome.result.message,
								},
							],
							isError: outcome.result.status !== "completed",
							timestamp,
						},
					);
				}

				const response = yield* Effect.tryPromise({
					try: (signal) =>
						ai.completeSimple(
							model,
							{ messages: context, tools: [tool] },
							{
								reasoning: "low",
								toolChoice: followUp ? "none" : "auto",
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

				if (response.stopReason === "toolUse" && !followUp) {
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
