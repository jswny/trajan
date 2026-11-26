import { clearCodeModeRun } from "@trajan/code-mode";
import type { CodeModeActivity } from "@trajan/code-mode";
import {
	FileChange,
	FilePreview,
	ToolActivity,
	ToolContent,
	toolPreviewBytes,
} from "@trajan/harness";
import type { ToolActivityPreview } from "@trajan/harness";
import { Option, Schema } from "effect";

export const RECENT_TOOL_CALLS = 8;

const ExecutionActivity = Schema.Struct({
	executionId: Schema.NonEmptyString,
	activity: Schema.Array(ToolActivity).check(Schema.isMaxLength(RECENT_TOOL_CALLS)),
});
const decodeActivity = Schema.decodeUnknownSync(Schema.UndefinedOr(ExecutionActivity));
const decodeContent = Schema.decodeUnknownOption(ToolContent);
const decodeFileChange = Schema.decodeUnknownOption(FileChange);
const decodeFilePreview = Schema.decodeUnknownOption(FilePreview);
const encoder = new TextEncoder();

function limitPreview(text: string) {
	const bytes = encoder.encode(text);
	const truncated = bytes.length > toolPreviewBytes;
	return {
		text: truncated
			? new TextDecoder().decode(bytes.subarray(0, toolPreviewBytes), { stream: true })
			: text,
		truncated,
	};
}

function preview(value: Schema.Json): typeof ToolActivityPreview.Type {
	return typeof value === "string"
		? { format: "text", ...limitPreview(value) }
		: { format: "json", ...limitPreview(JSON.stringify(value, null, 2)) };
}

export function filePreview(
	path: string,
	content: string,
	truncated = false,
): typeof FilePreview.Type {
	const bounded = limitPreview(content);
	return { format: "file", path, text: bounded.text, truncated: truncated || bounded.truncated };
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
	details,
}: CodeModeActivity): typeof ToolActivity.Type {
	const file =
		status === "completed" ? Option.getOrUndefined(decodeFilePreview(details)) : undefined;
	const output =
		file ??
		(reply?.status === "returned"
			? previewOutput(reply.value)
			: reply?.status === "failed"
				? preview(reply.message)
				: undefined);
	const change = status === "completed" ? decodeFileChange(details) : undefined;
	return {
		id,
		name,
		status,
		input: preview(input),
		...(output && { output }),
		...(change?._tag === "Some" && { fileChange: change.value }),
	};
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
