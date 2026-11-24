import { ToolActivity, TurnMessage } from "@trajan/harness";
import { Schema } from "effect";

export const ChatPath = "/api/chat";
export function isEffectChatPath(pathname: string) {
	return [ChatPath, `${ChatPath}/live`, `${ChatPath}/history`, `${ChatPath}/stop`].includes(
		pathname,
	);
}
export const ChatHistoryQuery = Schema.Struct({
	before: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
	limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export const ChatPage = Schema.Struct({
	entries: Schema.Array(
		Schema.Struct({
			id: Schema.Int,
			submissionId: Schema.NonEmptyString,
			message: TurnMessage,
		}),
	),
	nextBefore: Schema.NullOr(Schema.Int),
});

const RunId = Schema.NonEmptyString;
export const ChatStop = Schema.Struct({ runId: RunId });
export const ChatReceipt = Schema.Union([
	Schema.Struct({
		submissionId: Schema.NonEmptyString,
		runId: RunId,
		accepted: Schema.Boolean,
	}),
	Schema.Struct({
		submissionId: Schema.optionalKey(Schema.String),
		runId: Schema.Null,
		accepted: Schema.Literal(false),
		error: Schema.String,
	}),
]);
export const ChatStopReceipt = Schema.Struct({ runId: RunId, stopped: Schema.Boolean });

export const ChatPreview = Schema.Struct({
	runId: RunId,
	text: Schema.String,
	tool: Schema.NullOr(Schema.NonEmptyString),
	activity: Schema.Array(ToolActivity),
});
export const ChatToolInfo = Schema.Struct({ name: Schema.String, description: Schema.String });
export const ChatSnapshot = Schema.Struct({
	type: Schema.Literal("snapshot"),
	page: ChatPage,
	active: Schema.NullOr(
		Schema.Struct({
			runId: RunId,
			submissionId: Schema.NonEmptyString,
			prompt: Schema.NonEmptyString,
			state: Schema.Literals(["pending", "running", "stopping"]),
		}),
	),
	preview: Schema.NullOr(ChatPreview),
	queued: Schema.Natural,
	catalog: Schema.Array(ChatToolInfo),
});
export const ChatEvent = Schema.Union([
	ChatSnapshot,
	Schema.Struct({ type: Schema.Literal("preview"), ...ChatPreview.fields }),
	Schema.Struct({
		type: Schema.Literal("text-delta"),
		runId: RunId,
		text: Schema.String,
	}),
]);
