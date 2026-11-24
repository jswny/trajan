import { Schema } from "effect";
import { openAiTurnModel } from "../effect-harness/openai-responses";
import { modelConfig } from "../model-config";

export const compactSetupPrompt = "Prepare the compacted reference.";
export const compactResumePrompt = "Recall the compacted reference and save it using exec.";
export const compactReference = "amber-heron-795";
const compaction = { type: "compaction", encrypted_content: "opaque-fixture-compaction" };
const betweenCallAndOutput = {
	type: "compaction",
	encrypted_content: "opaque-compaction-before-tool-output",
};
const callId = "call_compaction_probe";
const Input = Schema.Struct({
	model: Schema.Literal(modelConfig.id),
	reasoning: Schema.Struct({ effort: Schema.Literal(modelConfig.reasoningEffort) }),
	context_management: Schema.Tuple([
		Schema.Struct({
			type: Schema.Literal("compaction"),
			compact_threshold: Schema.Literal(1000),
		}),
	]),
	store: Schema.Literal(false),
	stream: Schema.Literal(true),
	input: Schema.Array(Schema.JsonObject),
});
const decodeInput = Schema.decodeUnknownSync(Input);

function assistant(text: string, phase = "final_answer") {
	return { type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] };
}

function sseResponse(output: ReadonlyArray<Schema.JsonObject>, delta?: string) {
	const events = [
		...(delta ? [{ type: "response.output_text.delta", delta }] : []),
		{ type: "response.completed", response: { output } },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

export function createOpenAiResponsesFixture(
	tool: Parameters<typeof openAiTurnModel>[1],
	exec: Schema.JsonObject,
) {
	return openAiTurnModel(
		{
			run: async (request) => {
				const entry = Array.isArray(request) ? request[0] : request;
				if (entry?.provider !== "openai" || entry.endpoint !== "v1/responses") {
					throw new Error("Expected the OpenAI Responses gateway route.");
				}
				const { input } = decodeInput(entry.query);
				const last = input.at(-1);
				if (last?.content === compactSetupPrompt) {
					return sseResponse([assistant("Reference saved."), compaction], "Reference saved.");
				}
				if (input[0]?.encrypted_content !== compaction.encrypted_content) {
					throw new Error("Expected the durable compaction item at the start of the request.");
				}
				if (last?.content === compactResumePrompt && input.length === 2) {
					return sseResponse([
						{
							type: "function_call",
							name: "exec",
							call_id: callId,
							arguments: JSON.stringify(exec),
						},
						betweenCallAndOutput,
					]);
				}
				if (
					last?.type === "function_call_output" &&
					last.call_id === callId &&
					last.output === JSON.stringify(compactReference) &&
					input.at(-2)?.encrypted_content === betweenCallAndOutput.encrypted_content &&
					input.at(-3)?.call_id === callId
				) {
					return sseResponse(
						[
							assistant("I checked the workspace.", "commentary"),
							assistant(`Saved ${compactReference}.`),
						],
						`Saved ${compactReference}.`,
					);
				}
				throw new Error("Expected the compacted context followed by a matching exec result.");
			},
		},
		tool,
		"Local Responses fixture",
		1000,
	);
}
