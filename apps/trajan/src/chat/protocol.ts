import { ToolActivity, TurnMessage } from "@trajan/harness";
import { Schema } from "effect";

export const ChatPath = "/api/chat";
export const BrowserViewPath = `${ChatPath}/browser-view`;
export const BrowserViewRequest = Schema.Struct({ id: Schema.NonEmptyString });
export function isChatPath(pathname: string) {
	return [
		ChatPath,
		`${ChatPath}/live`,
		`${ChatPath}/history`,
		`${ChatPath}/stop`,
		BrowserViewPath,
	].includes(pathname);
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
export const BrowserWatch = Schema.NullOr(
	Schema.Struct({
		id: Schema.NonEmptyString,
		expiresAt: Schema.Int,
	}),
);
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
	browserWatch: BrowserWatch,
});
export const ChatEvent = Schema.Union([
	ChatSnapshot,
	Schema.Struct({ type: Schema.Literal("browser"), browserWatch: BrowserWatch }),
	Schema.Struct({ type: Schema.Literal("preview"), ...ChatPreview.fields }),
	Schema.Struct({
		type: Schema.Literal("text-delta"),
		runId: RunId,
		text: Schema.String,
	}),
]);
