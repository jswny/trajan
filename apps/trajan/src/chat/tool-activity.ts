import { clearCodeModeRun } from "@trajan/code-mode";
import type { CodeModeActivity } from "@trajan/code-mode";
import { ToolActivity, ToolContent, toolPreviewBytes } from "@trajan/harness";
import type { ToolActivityPreview } from "@trajan/harness";
import { Schema } from "effect";

export const RECENT_TOOL_CALLS = 8;

const ExecutionActivity = Schema.Struct({
	executionId: Schema.NonEmptyString,
	activity: Schema.Array(ToolActivity).check(Schema.isMaxLength(RECENT_TOOL_CALLS)),
});
const decodeActivity = Schema.decodeUnknownSync(Schema.UndefinedOr(ExecutionActivity));
const decodeContent = Schema.decodeUnknownOption(ToolContent);
const encoder = new TextEncoder();

function preview(value: Schema.Json): typeof ToolActivityPreview.Type {
	const format = typeof value === "string" ? "text" : "json";
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	const bytes = encoder.encode(text);
	const truncated = bytes.length > toolPreviewBytes;
	return {
		format,
		text: truncated
			? new TextDecoder().decode(bytes.subarray(0, toolPreviewBytes), { stream: true })
			: text,
		truncated,
	};
}

function previewOutput(value: Schema.Json) {
	const content = decodeContent(value);
	return content._tag === "Some" && content.value.length > 0
		? preview(
				content.value
					.map((part) => (part.type === "image" ? `Image (${part.mimeType})` : part.text))
					.join("\n"),
			)
		: preview(value);
}

export function toolActivity({
	id,
	name,
	status,
	input,
	reply,
}: CodeModeActivity): typeof ToolActivity.Type {
	const output =
		reply?.status === "returned"
			? previewOutput(reply.value)
			: reply?.status === "failed"
				? preview(reply.message)
				: undefined;
	return { id, name, status, input: preview(input), ...(output && { output }) };
}

export function toolActivityKey(runId: string) {
	return `chat-tool-activity:${runId}`;
}

export function clearToolState(storage: DurableObjectStorage, runId: string) {
	storage.kv.delete(toolActivityKey(runId));
	clearCodeModeRun(storage, runId);
}

export function readToolActivity(storage: DurableObjectStorage, runId: string) {
	return decodeActivity(storage.kv.get(toolActivityKey(runId)));
}

export function writeToolActivity(
	storage: DurableObjectStorage,
	runId: string,
	snapshot: typeof ExecutionActivity.Type,
) {
	storage.kv.put(toolActivityKey(runId), snapshot);
}
