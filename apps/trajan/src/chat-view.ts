import { toolResultContent } from "@trajan/harness";
import type {
	ToolActivity as ToolActivityEntry,
	ToolCall,
	ToolContent,
	ToolResult,
	UncertainToolEffect,
} from "@trajan/harness";
import { Schema } from "effect";
import type { ChatPage } from "./chat/protocol";
import { ToolActivity } from "./chat/tool-presentation";

const decodeActivity = Schema.decodeUnknownOption(ToolActivity);

export type ChatText = {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly text: string;
};

export type ChatTool = {
	readonly id: string;
	readonly role: "tool";
	readonly name: string;
	readonly input?: Schema.Json;
	readonly activity: ReadonlyArray<typeof ToolActivity.Type>;
	readonly result?: {
		readonly status: (typeof ToolResult.Type)["status"];
		readonly format: "json" | "text";
		readonly content: typeof ToolContent.Type;
		readonly uncertainEffects?: ReadonlyArray<typeof UncertainToolEffect.Type>;
	};
};

export type ChatMessage =
	| ChatText
	| ChatTool
	| {
			readonly id: string;
			readonly role: "notice";
			readonly status: "failed" | "cancelled";
			readonly text: string;
	  };

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
	const tool = {
		id: `tool:${JSON.stringify([submissionId, callId])}`,
		role: "tool" as const,
		name: call?.name ?? "Tool",
		...(call && { input: call.input }),
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
	const content: typeof ToolContent.Type =
		output?.type === "content"
			? output.parts
			: [
					{
						type: "text",
						text:
							result.status !== "completed"
								? result.message
								: JSON.stringify(result.output, null, 2),
					},
				];

	return {
		...tool,
		result: {
			status: result.status,
			format: output?.type === "json" ? "json" : "text",
			content,
			...(result.uncertainEffects && { uncertainEffects: result.uncertainEffects }),
		},
	};
}

export function chatMessages(entries: (typeof ChatPage.Type)["entries"]): Array<ChatMessage> {
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
				// The harness writes each call and result together. A page may start at the result.
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
