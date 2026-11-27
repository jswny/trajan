import type { Html } from "@effect/ui/html";
import { ChatMarkdown } from "./chat-markdown";
import type { ChatScreen } from "./chat-screen";
import { toolOutcome } from "./chat-view";
import type { ChatMessage, ChatTool, ChatTurn } from "./chat-view";
import { Icon } from "./icons";
import { ToolCard } from "./tool-card";

function TranscriptEntry<M>(h: Html.H<M>, message: Exclude<ChatMessage, ChatTool>) {
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

function ToolActivityDisclosure<M>(h: Html.H<M>, tools: ReadonlyArray<ChatTool>, working: boolean) {
	const outcomes = new Set(tools.map(toolOutcome));
	const warning = outcomes.has("unknown")
		? "Outcome unknown"
		: outcomes.has("failed")
			? "Tool failed"
			: undefined;
	return h.details
		.key("tool-activity")
		.class("group/tool-activity")
		.children(
			h.summary
				.attrs({ "data-tool-activity": "", "data-chat-entry": "", "data-inspect": "" })
				.class(
					"inline-flex min-h-7 max-w-full cursor-pointer list-none flex-wrap items-center gap-x-1.5 text-xs text-muted hover:text-ink focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring [&::-webkit-details-marker]:hidden",
				)
				.children(
					working && Icon(h, "loader", 12, "motion-safe:animate-spin"),
					working ? "Working…" : "Tool activity",
					Icon(h, "chevron", 12, "-rotate-90 group-open/tool-activity:rotate-0"),
					warning && h.span.class("text-danger").children(warning),
				),
			h.div
				.class("flex min-w-0 flex-col gap-2")
				.children(...tools.map((message) => ToolCard(h, { key: message.id, props: { message } }))),
		);
}

function TranscriptTurn<M>(h: Html.H<M>, { submissionId, messages, live, working }: ChatTurn) {
	const tools = messages.filter((message) => message.role === "tool");
	const entries = messages.filter((message) => message.role !== "tool");
	return h.div
		.key(submissionId)
		.class("min-w-0 space-y-2")
		.children(
			...entries
				.filter((message) => message.role === "user")
				.map((message) => TranscriptEntry(h, message)),
			(working || tools.length > 0) && ToolActivityDisclosure(h, tools, working),
			...entries
				.filter((message) => message.role !== "user")
				.map((message) => TranscriptEntry(h, message)),
			live &&
				h.div
					.key(`live:${live.id}`)
					.class("min-w-0 space-y-3")
					.children(ChatMarkdown(h, live.id, live.text, true), h.span.class("streaming-cursor")),
		);
}

export function ChatTranscript<M>(h: Html.H<M>, screen: typeof ChatScreen.Type, loadEarlier: M) {
	const { turns, earlier, loading, running, status, queued } = screen;
	const synced = status === "open";
	const empty = synced && turns.length === 0 && !earlier && !running;
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
			...turns.map((turn) => TranscriptTurn(h, turn)),
			queued > 0 &&
				h.p.key("queue").class("text-xs text-muted").children(`${queued} queued behind this run`),
		);
}
