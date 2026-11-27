import { openAiTurnModel } from "@trajan/model-openai";
import { Schema } from "effect";
import { openAiGatewayTransport } from "../chat/openai-gateway";
import { modelConfig } from "../model-config";

export const compactSetupPrompt = "Prepare the compacted reference.";
export const compactResumePrompt = "Recall the compacted reference and save it using exec.";
export const compactReference = "amber-heron-795";
export const scheduleOutcomePrompt = "What happened to the scheduled workspace check?";
export const remotePushRecoveryPrompt = "Recover the interrupted remote push.";
export const remotePushRecoveryCode = `import { push } from "codemode:git";
import { read_first } from "codemode:tools";
export default async function () {
  try {
    await push({ dir: "/workspace/repo", remote: "upstream", remoteRef: "refs/heads/review" });
  } catch (error) {
    if (error.code !== "interrupted") throw error;
  }
  for (let index = 0; index < 9; index++) await read_first();
  return "script finished";
}`;
const remotePushCallId = "call_remote_push";
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
		...(delta ? [{ type: "response.output_text.delta", item_id: "message", delta }] : []),
		{ type: "response.completed", response: { output } },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

export function createOpenAiResponsesFixture(
	tool: Parameters<typeof openAiTurnModel>[1]["tool"],
	exec: Schema.JsonObject,
) {
	return openAiTurnModel(
		openAiGatewayTransport({
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
				if (last?.content === remotePushRecoveryPrompt) {
					return sseResponse([
						{
							type: "function_call",
							name: "exec",
							call_id: remotePushCallId,
							arguments: JSON.stringify({ code: remotePushRecoveryCode }),
						},
					]);
				}
				if (last?.type === "function_call_output" && last.call_id === remotePushCallId) {
					const parts = Schema.decodeUnknownSync(
						Schema.Array(
							Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
						),
					)(last.output);
					if (
						!parts[0]?.text.startsWith("Trajan runtime reported uncertain effects") ||
						!parts[0].text.includes("refs/heads/review") ||
						!parts[0].text.includes("upstream") ||
						parts[1]?.text !== JSON.stringify("script finished")
					) {
						throw new Error("Expected remote uncertainty and the original script output.");
					}
					return sseResponse([assistant("Verify the remote branch before retrying the push.")]);
				}
				if (input[0]?.encrypted_content !== compaction.encrypted_content) {
					throw new Error("Expected the durable compaction item at the start of the request.");
				}
				if (last?.content === scheduleOutcomePrompt) {
					const outcome = input.at(-2)?.content;
					if (
						typeof outcome !== "string" ||
						!outcome.startsWith("Trajan runtime outcome\n") ||
						!outcome.includes("A scheduled task could not be queued after retries.")
					) {
						throw new Error("Expected the missed schedule after the saved compaction item.");
					}
					return sseResponse([assistant("The scheduled workspace check was missed.")]);
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
		}),
		{
			model: modelConfig.id,
			reasoningEffort: modelConfig.reasoningEffort,
			compactThreshold: 1000,
			instructions: "Local Responses fixture",
			runtimeLabels: modelConfig.runtimeLabels,
			tool,
		},
	);
}
