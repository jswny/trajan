import type { ToolActivity, ToolResult } from "@trajan/harness";
import { Schema } from "effect";
import type { ChatPage } from "./chat/protocol";

const ContentParts = Schema.Array(
	Schema.Union([
		Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
		Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String }),
	]),
);
const decodeContent = Schema.decodeUnknownOption(ContentParts);

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
	readonly result?: {
		readonly status: (typeof ToolResult.Type)["status"];
		readonly format: "json" | "text";
		readonly content: typeof ContentParts.Type;
		readonly activity: ReadonlyArray<typeof ToolActivity.Type>;
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

export function chatMessages(entries: (typeof ChatPage.Type)["entries"]): Array<ChatMessage> {
	return entries.flatMap(({ id, message }, index): ReadonlyArray<ChatMessage> => {
		const key = String(id);
		switch (message.role) {
			case "user":
			case "assistant":
			case "notice":
				return [{ id: key, ...message }];
			case "tool-call": {
				const next = entries[index + 1]?.message;
				if (next?.role === "tool" && next.callId === message.id) {
					return [];
				}
				return [{ id: key, role: "tool", name: message.name, input: message.input }];
			}
			case "tool": {
				// The harness writes each call and result together. A page may start at the result.
				const previous = entries[index - 1]?.message;
				const call =
					previous?.role === "tool-call" && previous.id === message.callId ? previous : undefined;
				const { result } = message;
				const decoded = result.status === "completed" ? decodeContent(result.output) : null;
				const content =
					decoded?._tag === "Some"
						? decoded.value
						: [
								{
									type: "text" as const,
									text:
										result.status === "completed"
											? JSON.stringify(result.output, null, 2)
											: result.message,
								},
							];
				return [
					{
						id: key,
						role: "tool",
						name: call?.name ?? "Tool",
						...(call && { input: call.input }),
						result: {
							status: result.status,
							format: result.status === "completed" && decoded?._tag !== "Some" ? "json" : "text",
							content,
							activity: result.activity ?? [],
						},
					},
				];
			}
			default:
				throw new Error("Unsupported chat message");
		}
	});
}
