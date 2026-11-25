import { Menu } from "@base-ui/react/menu";
import { useAtom } from "@effect/atom-react";
import {
	IconArrowShortUp,
	IconArrowUpFill,
	IconCheck,
	IconCircleCheck,
	IconCircleEllipsis,
	IconCircleX,
	IconLoader,
	IconSquircleFill,
} from "@pierre/icons/beta";
import type { ToolActivity } from "@trajan/harness";
import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChatMarkdown } from "./chat-markdown";
import type { ChatEntry, ChatMessage, ChatPart } from "./chat-view";
import { themePreference } from "./theme";
import { useChatSession } from "./use-chat-session";
import "./styles.css";

/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 32;

function ChatSettingsMenu() {
	const [mode, setMode] = useAtom(themePreference);

	return (
		<Menu.Root modal={false}>
			<Menu.Trigger
				aria-label="Chat settings"
				className="chat-button chat-floating-surface size-(--chat-control-height)"
			>
				<IconCircleEllipsis size={24} aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="end" sideOffset={8} collisionPadding={12} className="z-20">
					<Menu.Popup className="max-h-(--available-height) w-40 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-1 text-ink shadow-lg outline-none">
						<Menu.RadioGroup value={mode} onValueChange={setMode}>
							<Menu.GroupLabel className="px-3 pt-2 pb-1 text-xs font-medium text-muted">
								Theme
							</Menu.GroupLabel>
							{Object.entries({ auto: "Auto", light: "Light", dark: "Dark" }).map(
								([value, label]) => (
									<Menu.RadioItem
										key={value}
										value={value}
										closeOnClick
										className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 text-sm outline-none data-highlighted:bg-hover"
									>
										{label}
										<Menu.RadioItemIndicator className="text-accent">
											<IconCheck aria-hidden="true" />
										</Menu.RadioItemIndicator>
									</Menu.RadioItem>
								),
							)}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="max-h-40 overflow-auto rounded-lg bg-canvas p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
			{typeof value === "string" ? value : JSON.stringify(value, null, 2)}
		</pre>
	);
}

function ToolCallCard({
	part,
	running,
}: {
	part: Extract<ChatPart, { type: "tool-call" }>;
	running: boolean;
}) {
	return (
		<details className="rounded-xl border border-line bg-surface">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
				{running ? (
					<IconLoader
						size={12}
						aria-hidden="true"
						className="text-muted motion-safe:animate-spin"
					/>
				) : (
					<IconCircleCheck size={12} aria-hidden="true" className="text-success" />
				)}
				<span className="min-w-0 flex-1 truncate text-xs font-semibold">{part.name}</span>
				<span className="chat-badge">{running ? "Running" : "Called"}</span>
			</summary>
			<div className="border-t border-line px-3 py-3">
				<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
					Arguments
				</p>
				<JsonBlock value={part.arguments} />
			</div>
		</details>
	);
}

function ToolResultCard({ part }: { part: Extract<ChatPart, { type: "tool-result" }> }) {
	const text = part.content
		.filter((content) => content.type === "text")
		.map((content) => (content.type === "text" ? content.text : ""))
		.join("\n");
	const images = part.content.filter((content) => content.type === "image");
	return (
		<details className="rounded-xl border border-line bg-surface">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
				{part.error ? (
					<IconCircleX size={12} aria-hidden="true" className="text-danger" />
				) : (
					<IconCircleCheck size={12} aria-hidden="true" className="text-success" />
				)}
				<span className="min-w-0 flex-1 truncate text-xs">
					<span className="font-semibold">{part.name}</span>
					{text ? <span className="ml-2 text-muted">{text}</span> : null}
				</span>
				<span className="chat-badge" data-tone={part.error ? "danger" : undefined}>
					{part.error ? "Failed" : "Done"}
				</span>
			</summary>
			<div className="space-y-3 border-t border-line px-3 py-3">
				{part.activity.length > 0 ? <ToolActivityList activity={part.activity} /> : null}
				{text ? (
					<div>
						<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
							Result
						</p>
						<JsonBlock value={text} />
					</div>
				) : null}
				{images.map((image, index) =>
					image.type === "image" ? (
						<img
							key={index}
							src={`data:${image.mimeType};base64,${image.data}`}
							alt={`${part.name} output`}
							className="max-w-full rounded-lg"
						/>
					) : null,
				)}
			</div>
		</details>
	);
}

const toolActivityLabel = {
	running: "Running",
	completed: "Succeeded",
	failed: "Failed",
	interrupted: "Interrupted",
};

function ToolActivityList({ activity }: { activity: ReadonlyArray<typeof ToolActivity.Type> }) {
	return (
		<ul role="list" aria-label="Recent tool calls" className="max-h-36 space-y-1 overflow-y-auto">
			{activity.map(({ id, name, status }) => (
				<li key={id} className="flex min-w-0 items-center gap-3 text-xs">
					<span className="min-w-0 flex-1 truncate font-medium">{name}</span>
					<span className="chat-badge" data-tone={status === "failed" ? "danger" : undefined}>
						{toolActivityLabel[status]}
					</span>
				</li>
			))}
		</ul>
	);
}

function AssistantPart({
	part,
	running,
	streaming,
}: {
	part: ChatPart;
	running: boolean;
	streaming: boolean;
}) {
	switch (part.type) {
		case "text":
			return (
				<ChatMarkdown className="text-sm leading-6" isAnimating={streaming}>
					{part.text}
				</ChatMarkdown>
			);
		case "tool-call":
			return <ToolCallCard part={part} running={running} />;
		case "tool-result":
			return <ToolResultCard part={part} />;
		case "image":
			return (
				<img
					src={`data:${part.mimeType};base64,${part.data}`}
					alt=""
					className="max-w-full rounded-lg"
				/>
			);
	}
}

function UserMessage({ message }: { message: ChatEntry }) {
	const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
	return (
		<div className="flex justify-end">
			<div className="min-w-0 max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm leading-relaxed text-canvas">
				{text}
			</div>
		</div>
	);
}

function AssistantMessage({
	message,
	streaming = false,
	runningTools,
}: {
	message: ChatEntry;
	streaming?: boolean;
	runningTools: ReadonlyArray<string>;
}) {
	return (
		<div className="min-w-0 space-y-3">
			{message.parts.map((part, index) => (
				<AssistantPart
					key={`${message.id}-${index}`}
					part={part}
					streaming={streaming && index === message.parts.length - 1}
					running={streaming && part.type === "tool-call" && runningTools.includes(part.name)}
				/>
			))}
			{streaming ? <span className="streaming-cursor" /> : null}
		</div>
	);
}

function ToolMessage({ message }: { message: ChatEntry }) {
	return (
		<div className="space-y-2">
			{message.parts.map((part, index) =>
				part.type === "tool-result" ? (
					<ToolResultCard key={`${message.id}-${index}`} part={part} />
				) : null,
			)}
		</div>
	);
}

function Message({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
	switch (message.role) {
		case "user":
			return <UserMessage message={message} />;
		case "assistant":
			return <AssistantMessage message={message} streaming={streaming} runningTools={[]} />;
		case "tool":
			return <ToolMessage message={message} />;
		case "notice":
			return message.status === "failed" ? (
				<div role="alert" className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">
					{message.text}
				</div>
			) : (
				<p className="text-sm text-muted">{message.text}</p>
			);
	}
}

function App() {
	const contentRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	// Distance from the bottom to keep while earlier messages load above.
	const keepFromBottom = useRef<number | null>(null);
	// Whether the reader is at the bottom: new messages scroll into view only
	// then, not while they read earlier ones.
	const following = useRef(true);
	const lastScrollTop = useRef(0);
	const {
		status,
		messages,
		earlier,
		loading,
		live,
		active,
		activePrompt,
		queued,
		requestError,
		submission,
		preview,
		composer: { text: prompt, canSubmit, submitting },
		editPrompt: setPrompt,
		submit: submitPrompt,
		retrySubmit,
		stop,
		loadEarlier,
	} = useChatSession();
	const running = active !== null;
	const runningTools = preview?.tool ? [preview.tool] : [];
	const toolActivity = preview?.activity ?? [];
	const oldestId = messages[0]?.id;

	// Keep the latest reply visible as the transcript, composer, or viewport resizes.
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		const content = contentRef.current;
		if (scroller === null || content === null) {
			return;
		}
		const observer = new ResizeObserver(() => {
			if (following.current && keepFromBottom.current === null) {
				scroller.scrollTop = scroller.scrollHeight;
				lastScrollTop.current = scroller.scrollTop;
			}
		});
		observer.observe(scroller);
		observer.observe(content);
		return () => observer.disconnect();
	}, []);

	// Scrolling up stops following; scrolling back to the bottom resumes it.
	const onScroll = () => {
		const scroller = scrollRef.current;
		if (scroller === null) {
			return;
		}
		const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		if (fromBottom <= BOTTOM_THRESHOLD) {
			following.current = true;
		} else if (scroller.scrollTop < lastScrollTop.current - 1) {
			following.current = false;
		}
		lastScrollTop.current = scroller.scrollTop;
	};

	// Earlier messages loaded above: keep what was on screen in place.
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (scroller !== null && keepFromBottom.current !== null) {
			scroller.scrollTop = scroller.scrollHeight - keepFromBottom.current;
		}
		if (!loading) {
			keepFromBottom.current = null;
		}
	}, [oldestId, loading]);

	const showEarlier = () => {
		const scroller = scrollRef.current;
		if (scroller !== null) {
			keepFromBottom.current = scroller.scrollHeight - scroller.scrollTop;
		}
		loadEarlier();
	};

	const synced = status === "open";

	const submit = () => {
		if (!canSubmit) {
			return;
		}
		following.current = true;
		submitPrompt();
	};

	const empty = synced && messages.length === 0 && !earlier && !running;
	const connectionLabel = synced ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting";
	return (
		<section
			className="chat-layout relative flex h-dvh min-w-0 flex-col overflow-hidden bg-canvas text-ink"
			aria-label="Chat"
		>
			<header className="chat-header pointer-events-none absolute z-10">
				<div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5">
					<div className="chat-floating-surface flex h-(--chat-control-height) items-center gap-2.5 px-4">
						<h1 className="text-base font-semibold">Trajan</h1>
						<span role="status" className="chat-badge" data-tone={synced ? "success" : undefined}>
							{connectionLabel}
						</span>
					</div>
					<ChatSettingsMenu />
				</div>
			</header>

			<div
				ref={scrollRef}
				onScroll={onScroll}
				className="chat-transcript min-h-0 flex-1 overflow-y-auto"
			>
				<div ref={contentRef} className="flex min-h-full flex-col">
					<main className="mx-auto w-full max-w-3xl grow space-y-5 px-5 pt-(--chat-transcript-top) pb-6">
						{empty ? (
							<h2 className="py-10 text-center text-sm font-semibold sm:py-16">
								What can I help with?
							</h2>
						) : null}

						{earlier ? (
							<div className="flex justify-center">
								<button
									type="button"
									className="chat-button min-h-11 px-3 text-xs"
									disabled={loading || !synced}
									aria-busy={loading}
									onClick={showEarlier}
								>
									{loading ? (
										<IconLoader size={12} aria-hidden="true" className="motion-safe:animate-spin" />
									) : (
										<IconArrowShortUp size={12} aria-hidden="true" />
									)}
									Load earlier messages
								</button>
							</div>
						) : null}

						{messages.map((message) => (
							<Message key={message.id} message={message} />
						))}
						{activePrompt ? <Message message={activePrompt} /> : null}
						{live ? <Message message={live} streaming /> : null}

						{running && !live ? (
							<div className="w-fit max-w-full space-y-2 rounded-xl bg-surface px-4 py-3 ring ring-line">
								<div className="flex items-center gap-2 text-sm text-muted">
									<IconLoader aria-hidden="true" className="motion-safe:animate-spin" />
									{active?.state === "stopping"
										? "Stopping"
										: runningTools.length > 0
											? `Running ${runningTools.join(", ")}`
											: "Waiting for the model"}
								</div>
								{toolActivity.length > 0 ? <ToolActivityList activity={toolActivity} /> : null}
							</div>
						) : null}

						{queued > 0 ? (
							<p className="text-xs text-muted">{queued} queued behind this run</p>
						) : null}
					</main>

					<footer className="pointer-events-none sticky bottom-0 z-10">
						<div className="mx-auto max-w-3xl space-y-2 px-5 py-(--chat-edge-gap)">
							{submission?.status === "unconfirmed" ? (
								<div className="chat-floating-surface flex items-center gap-3 rounded-xl px-4 py-2">
									<p role="status" className="min-w-0 flex-1 truncate text-sm text-muted">
										Couldn’t confirm delivery of “{submission.draft.text}”.
									</p>
									<button
										type="button"
										className="chat-button min-h-11 bg-control px-3 text-xs"
										disabled={!synced}
										onClick={() => retrySubmit(submission.id)}
									>
										Retry sending
									</button>
								</div>
							) : null}
							{submission?.status === "rejected" ? (
								<p
									role="alert"
									className="chat-floating-surface rounded-xl px-4 py-2 text-sm text-danger"
								>
									{submission.message}
								</p>
							) : null}
							{requestError ? (
								<p
									role="alert"
									className="chat-floating-surface rounded-xl px-4 py-2 text-sm text-danger"
								>
									{requestError}
								</p>
							) : null}
							<form
								aria-busy={submitting}
								onSubmit={(event) => {
									event.preventDefault();
									submit();
								}}
								className="flex items-end gap-2"
							>
								<div className="chat-floating-surface flex min-h-(--chat-control-height) min-w-0 flex-1 items-center rounded-[calc(var(--chat-control-height)/2)] px-4 py-2 focus-within:ring-2 focus-within:ring-focus-ring">
									<textarea
										value={prompt}
										onChange={(event) => setPrompt(event.currentTarget.value)}
										onKeyDown={(event) => {
											if (
												event.key === "Enter" &&
												!event.shiftKey &&
												!event.nativeEvent.isComposing
											) {
												event.preventDefault();
												submit();
											}
										}}
										placeholder={running ? "Add a follow-up" : "Message Trajan"}
										aria-label="Message Trajan"
										rows={1}
										className="chat-composer field-sizing-content max-h-[min(8rem,30dvh)] w-full min-w-0 resize-none overflow-y-auto bg-transparent text-sm leading-6 outline-none placeholder:text-muted"
									/>
								</div>
								{running ? (
									<button
										type="button"
										aria-label="Stop"
										disabled={!synced || active?.state === "stopping"}
										className="chat-button chat-floating-surface size-(--chat-control-height)"
										onClick={stop}
									>
										<IconSquircleFill size={12} aria-hidden="true" />
									</button>
								) : null}
								<button
									type="submit"
									aria-label={running ? "Queue follow-up" : "Send message"}
									disabled={!canSubmit}
									className="chat-button chat-floating-surface send-button size-(--chat-control-height)"
								>
									<IconArrowUpFill aria-hidden="true" />
								</button>
							</form>
						</div>
					</footer>
				</div>
			</div>
		</section>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing #root element");
}
createRoot(root).render(<App />);
