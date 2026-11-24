import type { ToolActivity } from "@trajan/harness";
import { Schema } from "effect";
import type { ChatPage } from "./chat/protocol";

const ContentParts = Schema.Array(
	Schema.Union([
		Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
		Schema.Struct({ type: Schema.Literal("image"), mimeType: Schema.String, data: Schema.String }),
	]),
);
const decodeContent = Schema.decodeUnknownOption(ContentParts);
export type ChatPart =
	| (typeof ContentParts.Type)[number]
	| {
			readonly type: "tool-call";
			readonly id: string;
			readonly name: string;
			readonly arguments: Schema.Json;
	  }
	| {
			readonly type: "tool-result";
			readonly name: string;
			readonly content: typeof ContentParts.Type;
			readonly error: boolean;
			readonly activity: ReadonlyArray<typeof ToolActivity.Type>;
	  };

export type ChatEntry = {
	readonly id: string;
	readonly role: "user" | "assistant" | "tool";
	readonly parts: ReadonlyArray<ChatPart>;
};
export type ChatMessage =
	| ChatEntry
	| {
			readonly id: string;
			readonly role: "notice";
			readonly status: "failed" | "cancelled";
			readonly text: string;
	  };

export function chatText(id: string, role: "user" | "assistant", text: string): ChatEntry {
	return { id, role, parts: [{ type: "text", text }] };
}

export function chatMessages(entries: (typeof ChatPage.Type)["entries"]): Array<ChatMessage> {
	const names = new Map<string, string>();
	return entries.map(({ id, message }) => {
		const key = String(id);
		switch (message.role) {
			case "user":
			case "assistant":
				return chatText(key, message.role, message.text);
			case "notice":
				return { id: key, ...message };
			case "tool-call":
				names.set(message.id, message.name);
				return {
					id: key,
					role: "assistant",
					parts: [
						{ type: "tool-call", id: message.id, name: message.name, arguments: message.input },
					],
				};
			case "tool": {
				const { result } = message;
				const parts = result.status === "completed" ? decodeContent(result.output) : null;
				return {
					id: key,
					role: "tool",
					parts: [
						{
							type: "tool-result",
							name: names.get(message.callId) ?? "Tool",
							error: result.status !== "completed",
							activity: result.activity ?? [],
							content:
								parts?._tag === "Some"
									? parts.value
									: [
											{
												type: "text",
												text:
													result.status === "completed"
														? JSON.stringify(result.output, null, 2)
														: result.message,
											},
										],
						},
					],
				};
			}
			default:
				throw new Error("Unsupported chat message");
		}
	});
}
