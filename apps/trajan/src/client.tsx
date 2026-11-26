import { Menu } from "@base-ui/react/menu";
import { useAtom } from "@effect/atom-react";
import { IconEllipsis } from "@pierre/icons";
import {
	IconArrowShortUp,
	IconArrowUpFill,
	IconCheck,
	IconChevron,
	IconLoader,
	IconSquircleFill,
} from "@pierre/icons/beta";
import type { ToolActivity, ToolActivityPreview } from "@trajan/harness";
import { lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserViewer } from "./browser-view";
import { ChatMarkdown, ToolCode } from "./chat-markdown";
import type { ChatMessage, ChatText, ChatTool } from "./chat-view";
import { CurrentActivityChip } from "./current-activity";
import { ExecScript } from "./exec-script";
import { themePreference } from "./theme";
import { useChatSession } from "./use-chat-session";
import "./styles.css";

/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 32;
const FileDiff = lazy(() => import("./file-diff"));

function ChatSettingsMenu() {
	const [mode, setMode] = useAtom(themePreference);

	return (
		<Menu.Root modal={false}>
			<Menu.Trigger
				aria-label="Chat settings"
				className="chat-button chat-floating-surface size-(--chat-control-height)"
			>
				<IconEllipsis size={18} aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="end" sideOffset={8} collisionPadding={12} className="z-20">
					<Menu.Popup className="max-h-(--available-height) w-40 overflow-y-auto overscroll-contain rounded-(--chat-surface-radius) border border-line bg-surface p-1.5 text-ink shadow-lg outline-none">
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
										className="chat-compact-control flex cursor-pointer items-center justify-between gap-3 px-3 text-sm outline-none data-highlighted:bg-hover"
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

const toolResultLabel = { completed: "Done", failed: "Failed", unknown: "Outcome unknown" };

function ToolCard({ message, onInspect }: { message: ChatTool; onInspect: () => void }) {
	const [open, setOpen] = useState(false);
	const { input, name, result, activity } = message;
	const script =
		name === "exec" &&
		input &&
		typeof input === "object" &&
		"code" in input &&
		typeof input.code === "string"
			? input.code
			: undefined;
	const text = result?.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = result?.content.filter((part) => part.type === "image") ?? [];
	const uncertain = (result?.uncertainEffects?.length ?? 0) > 0;
	const failed = result?.status === "failed" || result?.status === "unknown" || uncertain;
	const step = !result && activity.at(-1);
	return (
		<details
			className="chat-tool-card group w-fit max-w-full border border-line bg-surface open:w-full"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary
				className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring [&::-webkit-details-marker]:hidden"
				onClick={onInspect}
			>
				<span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
					<span className="shrink-0 font-semibold">{name}</span>
					{step ? <span className="truncate text-muted">{step.name}</span> : null}
				</span>
				<span className="chat-badge" data-tone={failed ? "danger" : undefined}>
					{uncertain ? "Outcome unknown" : result ? toolResultLabel[result.status] : "Running"}
				</span>
				<IconChevron
					size={12}
					aria-hidden="true"
					className="shrink-0 text-muted group-open:rotate-180"
				/>
			</summary>
			<div className="space-y-3 border-t border-line px-3 py-3">
				{result?.uncertainEffects?.map(({ id, name, message }) => (
					<p
						key={id}
						className="wrap-anywhere rounded-(--chat-inset-radius) bg-danger/10 px-2.5 py-2 text-xs text-danger"
					>
						{name}. {message}
					</p>
				))}
				{open && activity.length > 0 ? (
					<ToolActivityList activity={activity} onInspect={onInspect} />
				) : null}
				{text ? (
					<div>
						<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
							Result
						</p>
						<ToolCode
							text={text}
							language={open && result?.format === "json" ? "json" : undefined}
						/>
					</div>
				) : null}
				{images.map((image, index) => (
					<img
						key={index}
						src={`data:${image.mimeType};base64,${image.data}`}
						alt={`${name} output`}
						className="max-w-full rounded-(--chat-inset-radius)"
					/>
				))}
				{script !== undefined ? (
					<ExecScript source={script} open={open} onInspect={onInspect} />
				) : input !== undefined ? (
					<div>
						<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
							Arguments
						</p>
						<ToolCode text={JSON.stringify(input, null, 2)} language={open ? "json" : undefined} />
					</div>
				) : null}
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

function fileLanguage(path: string) {
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (name === "dockerfile" || name === "makefile") {
		return name;
	}
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : undefined;
}

function ToolActivityDetail({
	label,
	preview,
}: {
	label: string;
	preview: typeof ToolActivityPreview.Type;
}) {
	const path = preview.format === "file" ? preview.path : undefined;
	return (
		<div>
			<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</p>
			{path ? <p className="mb-1 font-mono text-xs wrap-anywhere text-muted">{path}</p> : null}
			{path && preview.text === "" ? (
				<p className="text-xs text-muted">Empty file</p>
			) : (
				<ToolCode
					text={preview.text || '""'}
					language={path ? fileLanguage(path) : preview.format === "json" ? "json" : undefined}
					preserveLines={path !== undefined}
				/>
			)}
			{preview.truncated ? <p className="mt-1 text-xs text-muted">Preview truncated</p> : null}
		</div>
	);
}

const toolRow = "flex min-h-11 min-w-0 items-center gap-2 px-2.5 py-1.5 text-xs";

function ToolActivityRow({
	entry,
	onInspect,
}: {
	entry: typeof ToolActivity.Type;
	onInspect: () => void;
}) {
	const [open, setOpen] = useState(false);
	const { name, status, input, output, fileChange } = entry;
	const previews = (
		<>
			{input ? <ToolActivityDetail label="Arguments" preview={input} /> : null}
			{output ? <ToolActivityDetail label="Result" preview={output} /> : null}
		</>
	);
	const heading = (
		<>
			<span className="min-w-0 flex-1 truncate font-medium">{name}</span>
			<span className="chat-badge" data-tone={status === "failed" ? "danger" : undefined}>
				{toolActivityLabel[status]}
			</span>
		</>
	);
	return input || output || fileChange ? (
		<details
			className="group/call rounded-(--chat-inset-radius) border border-transparent open:border-line"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary
				className={`${toolRow} cursor-pointer list-none rounded-(--chat-inset-radius) hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring [&::-webkit-details-marker]:hidden`}
				onClick={onInspect}
			>
				{heading}
				<IconChevron
					size={12}
					aria-hidden="true"
					className="shrink-0 text-muted group-open/call:rotate-180"
				/>
			</summary>
			{open ? (
				<div className="space-y-3 px-2.5 pb-2.5">
					{fileChange ? (
						<section
							aria-label="File changes"
							className="max-h-56 min-w-0 overflow-auto rounded-(--chat-inset-radius) bg-canvas [--diffs-font-size:0.75rem]"
						>
							{fileChange.diff ? (
								<Suspense
									fallback={<p className="px-2.5 py-2 text-xs text-muted">Loading diff…</p>}
								>
									<FileDiff patch={fileChange.diff} />
								</Suspense>
							) : (
								<div className="space-y-1 px-2.5 py-2 text-xs">
									<p className="font-mono wrap-anywhere">{fileChange.path}</p>
									<p className="text-muted">
										{fileChange.kind === "unchanged"
											? "No content changes"
											: "Diff preview unavailable"}
									</p>
								</div>
							)}
						</section>
					) : null}
					{fileChange && (input || output) ? (
						<details>
							<summary
								className="w-fit cursor-pointer rounded-(--chat-inset-radius) px-2.5 py-1.5 text-xs text-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring"
								onClick={onInspect}
							>
								Arguments and receipt
							</summary>
							<div className="mt-2 space-y-3">{previews}</div>
						</details>
					) : (
						previews
					)}
				</div>
			) : null}
		</details>
	) : (
		<div className={toolRow}>{heading}</div>
	);
}

function ToolActivityList({
	activity,
	onInspect,
}: {
	activity: ReadonlyArray<typeof ToolActivity.Type>;
	onInspect: () => void;
}) {
	return (
		<ul role="list" aria-label="Recent tool calls" className="space-y-1">
			{activity.map((entry) => (
				<li key={entry.id} className="min-w-0">
					<ToolActivityRow entry={entry} onInspect={onInspect} />
				</li>
			))}
		</ul>
	);
}

function UserMessage({ message }: { message: ChatText }) {
	return (
		<div className="flex justify-end">
			<div className="min-w-0 max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-(--chat-surface-radius) bg-ink px-4 py-2.5 text-sm leading-relaxed text-canvas">
				{message.text}
			</div>
		</div>
	);
}

function Message({ message, onInspect }: { message: ChatMessage; onInspect: () => void }) {
	switch (message.role) {
		case "user":
			return <UserMessage message={message} />;
		case "assistant":
			return <ChatMarkdown className="min-w-0 text-sm leading-6">{message.text}</ChatMarkdown>;
		case "tool":
			return <ToolCard message={message} onInspect={onInspect} />;
		case "notice":
			return message.status === "failed" ? (
				<div
					role="alert"
					className="rounded-(--chat-surface-radius) bg-danger/10 px-4 py-3 text-sm text-danger"
				>
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
	const inspectionFrame = useRef<number | null>(null);
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
	const latestTool = preview?.tools.at(-1);
	const currentTool = latestTool?.result ? undefined : latestTool;
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
		return () => {
			observer.disconnect();
			if (inspectionFrame.current !== null) {
				cancelAnimationFrame(inspectionFrame.current);
			}
		};
	}, []);

	// A native disclosure changes layout after the click. Read it before following again.
	const inspectTool = () => {
		const scroller = scrollRef.current;
		if (scroller === null || !following.current) {
			return;
		}
		following.current = false;
		inspectionFrame.current = requestAnimationFrame(() => {
			inspectionFrame.current = null;
			const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
			following.current = fromBottom <= BOTTOM_THRESHOLD;
		});
	};

	// Scrolling up stops following; scrolling back to the bottom resumes it.
	const onScroll = () => {
		const scroller = scrollRef.current;
		if (scroller === null) {
			return;
		}
		const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		if (inspectionFrame.current !== null) {
			lastScrollTop.current = scroller.scrollTop;
			return;
		}
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
	const browsing =
		synced &&
		active?.state === "running" &&
		currentTool !== undefined &&
		currentTool.activity.some(
			({ name, status }) =>
				status === "running" &&
				(name === "browserNavigate" || name === "browserRead" || name === "browserScreenshot"),
		);
	const turnStatus = !running
		? null
		: active?.state === "stopping"
			? "Stopping"
			: live
				? "Responding"
				: currentTool
					? `Running ${currentTool.call.name}`
					: "Waiting for the model";

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
			className="chat-layout relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden bg-canvas text-ink"
			aria-label="Chat"
		>
			<div
				ref={scrollRef}
				onScroll={onScroll}
				className="chat-transcript min-h-0 flex-1 overflow-y-auto"
			>
				<header className="pointer-events-none sticky top-0 z-10 h-0">
					<div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-(--chat-column-gutter) pt-(--chat-edge-gap)">
						<div className="chat-floating-surface flex h-(--chat-control-height) items-center gap-2.5 px-3">
							<h1 className="text-base font-semibold">Trajan</h1>
							<span role="status" className="chat-badge" data-tone={synced ? "success" : undefined}>
								{connectionLabel}
							</span>
						</div>
						<ChatSettingsMenu />
					</div>
				</header>
				<div ref={contentRef} className="flex min-h-full flex-col">
					<main className="mx-auto w-full max-w-3xl grow space-y-5 px-(--chat-column-gutter) pt-(--chat-transcript-top) pb-6">
						{empty ? (
							<h2 className="py-10 text-center text-sm font-semibold sm:py-16">
								What can I help with?
							</h2>
						) : null}

						{earlier ? (
							<div className="flex justify-center">
								<button
									type="button"
									className="chat-button chat-compact-control px-3 text-xs"
									disabled={loading || !synced}
									aria-busy={loading}
									onClick={showEarlier}
								>
									{loading ? (
										<IconLoader
											size={12}
											aria-hidden="true"
											className="motion-safe:animate-spin motion-reduce:animate-pulse"
										/>
									) : (
										<IconArrowShortUp size={12} aria-hidden="true" />
									)}
									Load earlier messages
								</button>
							</div>
						) : null}

						{messages.map((message) => (
							<Message key={message.id} message={message} onInspect={inspectTool} />
						))}
						{live ? (
							<div className="min-w-0 space-y-3">
								<ChatMarkdown className="text-sm leading-6" isAnimating>
									{live.text}
								</ChatMarkdown>
								<span className="streaming-cursor" />
							</div>
						) : null}

						{queued > 0 ? (
							<p className="text-xs text-muted">{queued} queued behind this run</p>
						) : null}
					</main>

					<footer className="chat-footer pointer-events-none sticky bottom-0 z-10">
						<div className="mx-auto max-w-3xl space-y-2 px-(--chat-column-gutter) py-(--chat-edge-gap)">
							{submission?.status === "unconfirmed" ? (
								<div className="chat-floating-surface flex items-center gap-3 px-4 py-2">
									<p role="status" className="min-w-0 flex-1 truncate text-sm text-muted">
										Couldn’t confirm delivery of “{submission.draft.text}”.
									</p>
									<button
										type="button"
										className="chat-button chat-compact-control bg-control px-3 text-xs"
										disabled={!synced}
										onClick={() => retrySubmit(submission.id)}
									>
										Retry sending
									</button>
								</div>
							) : null}
							{submission?.status === "rejected" ? (
								<p role="alert" className="chat-floating-surface px-4 py-2 text-sm text-danger">
									{submission.message}
								</p>
							) : null}
							{requestError ? (
								<p role="alert" className="chat-floating-surface px-4 py-2 text-sm text-danger">
									{requestError}
								</p>
							) : null}
							<CurrentActivityChip turnStatus={turnStatus} browsing={browsing} connected={synced} />
							<form
								aria-busy={submitting}
								onSubmit={(event) => {
									event.preventDefault();
									submit();
								}}
								className="flex items-end gap-2"
							>
								<div className="chat-floating-surface flex min-h-(--chat-control-height) min-w-0 flex-1 items-center px-4 py-2 focus-within:ring-2 focus-within:ring-focus-ring">
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
createRoot(root).render(
	<BrowserViewer>
		<App />
	</BrowserViewer>,
);
