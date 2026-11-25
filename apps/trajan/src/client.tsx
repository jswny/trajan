import { Dialog } from "@base-ui/react/dialog";
import { useAtom } from "@effect/atom-react";
import {
	IconArrowShortUp,
	IconArrowUpFill,
	IconChevron,
	IconCircleCheck,
	IconCircleX,
	IconGear,
	IconLoader,
	IconSquircleFill,
	IconX,
} from "@pierre/icons/beta";
import type { ToolActivity } from "@trajan/harness";
import { Atom } from "effect/reactivity";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChatMarkdown } from "./chat-markdown";
import type { ChatEntry, ChatMessage, ChatPart } from "./chat-view";
import type { ChatToolInfo } from "./chat/protocol";
import { themePreference } from "./theme";
import { useChatSession } from "./use-chat-session";
import "./styles.css";

/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 32;
const toolsDialogOpenAtom = Atom.make<boolean>(false);

function ThemeSwitcher() {
	const [mode, setMode] = useAtom(themePreference);

	return (
		<div className="relative">
			<select
				aria-label="Color theme"
				className="h-11 w-21 cursor-pointer appearance-none rounded-md border border-line bg-control ps-3 pe-8 text-xs text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
				value={mode}
				onChange={(event) => setMode(event.currentTarget.value)}
			>
				<option value="auto">Auto</option>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
			</select>
			<IconChevron
				size={12}
				aria-hidden="true"
				className="pointer-events-none absolute end-2.5 top-1/2 -translate-y-1/2 text-muted"
			/>
		</div>
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

function ToolsDialog({
	tools,
	activeTools,
}: {
	tools: ReadonlyArray<typeof ChatToolInfo.Type>;
	activeTools: ReadonlyArray<string>;
}) {
	return (
		<Dialog.Portal>
			<Dialog.Backdrop className="absolute inset-0 z-10 bg-black/40" />
			<Dialog.Popup className="tools-dialog fixed left-1/2 z-20 flex w-96 -translate-x-1/2 flex-col overflow-hidden rounded-xl bg-surface shadow-lg ring ring-line">
				<div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
					<Dialog.Title className="text-sm font-semibold">Tools</Dialog.Title>
					<Dialog.Close className="chat-button size-11" aria-label="Close tools">
						<IconX aria-hidden="true" />
					</Dialog.Close>
				</div>
				<div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-3">
					{tools.map((tool) => (
						<div key={tool.name} className="rounded-lg bg-surface p-3 ring ring-line">
							<div className="flex items-center gap-2">
								{activeTools.includes(tool.name) ? (
									<IconLoader
										size={12}
										aria-hidden="true"
										className="text-accent motion-safe:animate-spin"
									/>
								) : (
									<IconGear size={12} aria-hidden="true" className="text-muted" />
								)}
								<code className="text-xs font-semibold">{tool.name}</code>
							</div>
							<p className="mt-1 text-xs text-muted">{tool.description}</p>
						</div>
					))}
				</div>
			</Dialog.Popup>
		</Dialog.Portal>
	);
}

function App() {
	const [toolsDialogOpen, setToolsDialogOpen] = useAtom(toolsDialogOpenAtom);
	const endRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLElement>(null);
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
		catalog,
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
	const newestId = messages.at(-1)?.id;
	const oldestId = messages[0]?.id;

	// Follow new messages, not the earlier ones loading above.
	useEffect(() => {
		if (following.current) {
			endRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [newestId, preview?.text, active?.runId, toolActivity.length]);

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
		<Dialog.Root open={toolsDialogOpen} onOpenChange={setToolsDialogOpen}>
			<section
				className="chat-layout flex h-dvh min-w-0 flex-col overflow-hidden bg-canvas text-ink"
				aria-label="Chat"
			>
				<header className="shrink-0 border-b border-line bg-surface">
					<div className="mx-auto flex min-h-15 max-w-3xl items-center justify-between gap-2 px-3 py-2 sm:px-5">
						<h1 className="text-base font-semibold">Trajan</h1>
						<div className="flex shrink-0 items-center gap-1 sm:gap-2">
							<span className="chat-badge" data-tone={synced ? "success" : undefined}>
								{connectionLabel}
							</span>
							<Dialog.Trigger className="chat-button size-11" aria-label="Tools">
								<IconGear aria-hidden="true" />
							</Dialog.Trigger>
							<ThemeSwitcher />
						</div>
					</div>
				</header>

				<main ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
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

						<div ref={endRef} />
					</div>
				</main>

				<div className="shrink-0 border-t border-line bg-surface">
					{submission?.status === "unconfirmed" ? (
						<div className="mx-auto flex max-w-3xl items-center gap-3 px-5 pt-3">
							<p role="status" className="flex-1 truncate text-sm text-muted">
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
						<p role="alert" className="mx-auto max-w-3xl px-5 pt-3 text-sm text-danger">
							{submission.message}
						</p>
					) : null}
					{requestError ? (
						<p role="alert" className="mx-auto max-w-3xl px-5 pt-3 text-sm text-danger">
							{requestError}
						</p>
					) : null}
					<form
						aria-busy={submitting}
						onSubmit={(event) => {
							event.preventDefault();
							submit();
						}}
						className="mx-auto max-w-3xl px-5 py-3 sm:py-4"
					>
						<div className="flex items-end gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-focus-ring">
							<textarea
								value={prompt}
								onChange={(event) => setPrompt(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										submit();
									}
								}}
								placeholder={running ? "Add a follow-up" : "Message Trajan"}
								aria-label="Message Trajan"
								rows={2}
								className="chat-composer min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-muted"
							/>
							{running ? (
								<button
									type="button"
									aria-label="Stop"
									disabled={!synced || active?.state === "stopping"}
									className="chat-button mb-0.5 size-11 bg-control"
									onClick={stop}
								>
									<IconSquircleFill size={12} aria-hidden="true" />
								</button>
							) : null}
							<button
								type="submit"
								aria-label={running ? "Queue follow-up" : "Send message"}
								disabled={!canSubmit}
								className="chat-button send-button mb-0.5 size-11"
							>
								<IconArrowUpFill aria-hidden="true" />
							</button>
						</div>
					</form>
				</div>
			</section>
			<ToolsDialog tools={catalog} activeTools={runningTools} />
		</Dialog.Root>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing #root element");
}
createRoot(root).render(<App />);
