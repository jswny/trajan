import { ToolContentPart, toolResultContent, UncertainToolEffect } from "@trajan/harness";
import type { ToolResult } from "@trajan/harness";
import type { ToolActivity as ToolActivityEntry, ToolCall } from "@trajan/harness";
import { Schema } from "effect";
import type { ChatPage } from "./chat/protocol";
import { ToolActivity } from "./chat/tool-presentation";
import { execName, ExecInput } from "./exec-contract";

const decodeActivity = Schema.decodeUnknownOption(ToolActivity);
const decodeScript = Schema.decodeUnknownOption(ExecInput);

export const ChatText = Schema.Struct({
	id: Schema.String,
	role: Schema.Literals(["user", "assistant"]),
	text: Schema.String,
});
export type ChatText = typeof ChatText.Type;

export const ChatTool = Schema.Struct({
	id: Schema.String,
	role: Schema.Literal("tool"),
	name: Schema.String,
	argument: Schema.optionalKey(
		Schema.Struct({
			type: Schema.Literals(["script", "json"]),
			source: Schema.String,
		}),
	),
	activity: Schema.Array(ToolActivity),
	result: Schema.optionalKey(
		Schema.Struct({
			status: Schema.Literals(["completed", "failed", "unknown"]),
			content: Schema.Array(
				Schema.Union([
					ToolContentPart,
					Schema.Struct({ type: Schema.Literal("json"), text: Schema.String }),
				]),
			),
			uncertainEffects: Schema.optionalKey(Schema.Array(UncertainToolEffect)),
		}),
	),
});
export type ChatTool = typeof ChatTool.Type;

export function toolOutcome({ result }: ChatTool) {
	return result?.uncertainEffects?.length ? "unknown" : result?.status;
}

export const ChatMessage = Schema.Union([
	ChatText,
	ChatTool,
	Schema.Struct({
		id: Schema.String,
		role: Schema.Literal("notice"),
		status: Schema.Literals(["failed", "cancelled"]),
		text: Schema.String,
	}),
]);
export type ChatMessage = typeof ChatMessage.Type;

export const ChatTurn = Schema.Struct({
	submissionId: Schema.String,
	messages: Schema.Array(ChatMessage),
	live: Schema.NullOr(ChatText),
	working: Schema.Boolean,
});
export type ChatTurn = typeof ChatTurn.Type;

export function chatText(id: string, role: ChatText["role"], text: string): ChatText {
	return { id, role, text };
}

export function chatTool(
	submissionId: string,
	callId: string,
	call?: typeof ToolCall.Type,
	result?: typeof ToolResult.Type,
	activity: ReadonlyArray<typeof ToolActivityEntry.Type> = [],
): ChatTool {
	const script = call?.name === execName ? decodeScript(call.input) : undefined;
	const argument =
		script?._tag === "Some"
			? { type: "script" as const, source: script.value.code }
			: call && { type: "json" as const, source: JSON.stringify(call.input, null, 2) };
	const tool = {
		id: `tool:${JSON.stringify([submissionId, callId])}`,
		role: "tool" as const,
		name: call?.name ?? "Tool",
		...(argument && { argument }),
		activity: (result?.activity ?? activity).map((entry) => {
			const parsed = decodeActivity(entry);
			return parsed._tag === "Some"
				? parsed.value
				: {
						id: entry.id,
						name: entry.name,
						status: entry.status,
					};
		}),
	};
	if (!result) {
		return tool;
	}
	const output = result.status === "completed" ? toolResultContent(result) : null;
	const content =
		output?.type === "content"
			? output.parts
			: result.status === "completed"
				? [{ type: "json" as const, text: JSON.stringify(result.output, null, 2) }]
				: [{ type: "text" as const, text: result.message }];

	return {
		...tool,
		result: {
			status: result.status,
			content,
			...(result.uncertainEffects && { uncertainEffects: result.uncertainEffects }),
		},
	};
}

function chatMessages(entries: (typeof ChatPage.Type)["entries"]): Array<ChatMessage> {
	return entries.flatMap(({ id, submissionId, message }, index): ReadonlyArray<ChatMessage> => {
		const key = String(id);
		switch (message.role) {
			case "user":
				return [chatText(`user:${submissionId}`, "user", message.text)];
			case "assistant":
			case "notice":
				return [{ id: key, ...message }];
			case "tool-call": {
				const next = entries[index + 1]?.message;
				if (next?.role === "tool" && next.callId === message.id) {
					return [];
				}
				return [chatTool(submissionId, message.id, message)];
			}
			case "tool": {
				const previous = entries[index - 1]?.message;
				const call =
					previous?.role === "tool-call" && previous.id === message.callId ? previous : undefined;
				return [chatTool(submissionId, message.callId, call, message.result)];
			}
			default:
				throw new Error("Unsupported chat message");
		}
	});
}

export function chatTurns(entries: (typeof ChatPage.Type)["entries"]): ReadonlyArray<ChatTurn> {
	return Array.from(
		Map.groupBy(entries, (entry) => entry.submissionId),
		([submissionId, turn]) => ({
			submissionId,
			messages: chatMessages(turn),
			live: null,
			working: false,
		}),
	);
}
