import { ToolActivity } from "@trajan/effect-harness";
import { Schema } from "effect";

export const RECENT_TOOL_CALLS = 8;

const ExecutionActivity = Schema.Struct({
	executionId: Schema.NonEmptyString,
	activity: Schema.Array(ToolActivity).check(Schema.isMaxLength(RECENT_TOOL_CALLS)),
});
const decodeActivity = Schema.decodeUnknownSync(Schema.UndefinedOr(ExecutionActivity));

export function toolActivityKey(runId: string) {
	return `effect-tool-activity:${runId}`;
}

export function toolIntentPrefix(runId: string) {
	return `effect-tool-intent:${runId}:`;
}

export function claimToolIntent(
	storage: DurableObjectStorage,
	runId: string,
	executionId: string,
	callId: string,
) {
	const key = `${toolIntentPrefix(runId)}${JSON.stringify([executionId, callId])}`;
	if (storage.kv.get(key) !== undefined) {
		return false;
	}
	storage.kv.put(key, true);
	return true;
}

export function clearToolState(storage: DurableObjectStorage, runId: string) {
	storage.kv.delete(toolActivityKey(runId));
	for (const [key] of Array.from(storage.kv.list({ prefix: toolIntentPrefix(runId) }))) {
		storage.kv.delete(key);
	}
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
