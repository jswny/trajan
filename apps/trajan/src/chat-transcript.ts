import type { Html } from "@effect/ui/html";
import { ChatMarkdown } from "./chat-markdown";
import type { ChatScreen } from "./chat-screen";
import type { ChatMessage } from "./chat-view";
import { Icon } from "./icons";
import { ToolCard } from "./tool-card";

function TranscriptEntry<M>(h: Html.H<M>, message: ChatMessage) {
	switch (message.role) {
		case "user":
			return h.div
				.key(message.id)
				.attr("data-chat-entry", "")
				.class("flex justify-end")
				.children(
					h.div
						.class(
							"min-w-0 max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-(--chat-surface-radius) bg-ink px-4 py-2.5 text-sm leading-relaxed text-canvas",
						)
						.children(message.text),
				);
		case "assistant":
			return h.div
				.key(message.id)
				.attr("data-chat-entry", "")
				.children(ChatMarkdown(h, message.id, message.text));
		case "tool":
			return ToolCard(h, { key: message.id, props: { message } });
		case "notice":
			return message.status === "failed"
				? h.div
						.key(message.id)
						.attrs({ "data-chat-entry": "", role: "alert" })
						.class("rounded-(--chat-surface-radius) bg-danger/10 px-4 py-3 text-sm text-danger")
						.children(message.text)
				: h.p
						.key(message.id)
						.attr("data-chat-entry", "")
						.class("text-sm text-muted")
						.children(message.text);
	}
}

export function ChatTranscript<M>(h: Html.H<M>, screen: typeof ChatScreen.Type, loadEarlier: M) {
	const { messages, earlier, loading, running, status, live, queued } = screen;
	const synced = status === "open";
	const empty = synced && messages.length === 0 && !earlier && !running;
	return h.main
		.class(
			"mx-auto w-full max-w-3xl grow space-y-5 px-(--chat-column-gutter) pt-(--chat-transcript-top) pb-6",
		)
		.children(
			empty &&
				h.h2
					.class("py-10 text-center text-sm font-semibold sm:py-16")
					.children("What can I help with?"),
			earlier &&
				h.div
					.key("load-earlier")
					.class("flex justify-center")
					.children(
						h.button
							.attrs({
								type: "button",
								"data-load-earlier": "",
								"aria-busy": String(loading),
								disabled: loading || !synced ? "" : undefined,
							})
							.class("chat-button chat-compact-control px-3 text-xs")
							.on("click", loadEarlier)
							.children(
								loading
									? Icon(h, "loader", 12, "motion-safe:animate-spin motion-reduce:animate-pulse")
									: Icon(h, "arrowShortUp", 12),
								"Load earlier messages",
							),
					),
			...messages.map((message) => TranscriptEntry(h, message)),
			live &&
				h.div
					.key(live.id)
					.class("min-w-0 space-y-3")
					.children(ChatMarkdown(h, live.id, live.text, true), h.span.class("streaming-cursor")),
			queued > 0 &&
				h.p.key("queue").class("text-xs text-muted").children(`${queued} queued behind this run`),
		);
}
