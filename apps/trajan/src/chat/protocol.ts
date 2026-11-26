import { ToolActivity, ToolCall, ToolResult, TurnMessage } from "@trajan/harness";
import { Schema } from "effect";

export const ChatPath = "/api/chat";
export const ChatHistoryPath = `${ChatPath}/history`;
export const ChatStopPath = `${ChatPath}/stop`;
export const BrowserViewPath = `${ChatPath}/browser-view`;
export const BrowserViewRequest = Schema.Struct({ id: Schema.NonEmptyString });
export function isChatPath(pathname: string) {
	return [ChatPath, `${ChatPath}/live`, ChatHistoryPath, ChatStopPath, BrowserViewPath].includes(
		pathname,
	);
}
export const BrowserViewResponse = Schema.Union([
	Schema.Struct({ status: Schema.Literal("closed") }),
	Schema.Struct({
		status: Schema.Literal("open"),
		url: Schema.String.check(
			Schema.makeFilter((value) => {
				const url = URL.parse(value);
				return (
					url?.origin === "https://live.browser.run" &&
					url.pathname === "/ui/view" &&
					!url.username &&
					!url.password &&
					url.searchParams.get("mode") === "tab" &&
					Boolean(url.searchParams.get("wss"))
				);
			}),
		),
	}),
]);
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
export const ChatRejectedReceipt = Schema.Struct({
	submissionId: Schema.optionalKey(Schema.String),
	runId: Schema.Null,
	accepted: Schema.Literal(false),
	error: Schema.String,
});
export const ChatReceipt = Schema.Union([
	Schema.Struct({
		submissionId: Schema.NonEmptyString,
		runId: RunId,
		accepted: Schema.Boolean,
	}),
	ChatRejectedReceipt,
]);
export const ChatStopReceipt = Schema.Struct({ runId: RunId, stopped: Schema.Boolean });

export const ChatToolPreview = Schema.Struct({
	call: ToolCall,
	activity: Schema.Array(ToolActivity),
	result: Schema.optionalKey(ToolResult),
});
export const ChatPreview = Schema.Struct({
	runId: RunId,
	text: Schema.String,
	tools: Schema.Array(ChatToolPreview),
});

export function updateToolPreview(
	preview: typeof ChatPreview.Type,
	tool: typeof ChatToolPreview.Type,
): typeof ChatPreview.Type {
	const existing = preview.tools.find(({ call }) => call.id === tool.call.id);
	if (!existing) {
		return { ...preview, text: "", tools: [...preview.tools, tool] };
	}
	if (
		!tool.result &&
		(existing.result || (tool.activity.length === 0 && existing.activity.length > 0))
	) {
		return preview;
	}
	return { ...preview, tools: preview.tools.map((entry) => (entry === existing ? tool : entry)) };
}
export const BrowserWatch = Schema.NullOr(
	Schema.Struct({
		id: Schema.NonEmptyString,
		expiresAt: Schema.Int,
	}),
);
export const ChatRunState = Schema.Struct({
	type: Schema.Literal("run-state"),
	active: Schema.NullOr(
		Schema.Struct({
			runId: RunId,
			submissionId: Schema.NonEmptyString,
			prompt: Schema.NonEmptyString,
			state: Schema.Literals(["pending", "running", "stopping"]),
		}),
	),
	queued: Schema.Natural,
});
export const ChatSnapshot = Schema.Struct({
	...ChatRunState.fields,
	type: Schema.Literal("snapshot"),
	page: ChatPage,
	preview: Schema.NullOr(ChatPreview),
	browserWatch: BrowserWatch,
});
export const ChatEvent = Schema.Union([
	ChatSnapshot,
	ChatRunState,
	Schema.Struct({ type: Schema.Literal("browser"), browserWatch: BrowserWatch }),
	Schema.Struct({ type: Schema.Literal("reset"), runId: RunId }),
	Schema.Struct({ type: Schema.Literal("tool"), runId: RunId, tool: ChatToolPreview }),
	Schema.Struct({
		type: Schema.Literal("text-delta"),
		runId: RunId,
		text: Schema.String,
	}),
]);
