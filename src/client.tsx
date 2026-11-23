import { Badge, Button, Dialog, Empty, InputArea, Surface } from "@cloudflare/kumo";
import { useAtom } from "@effect/atom-react";
import {
	IconAgentFill,
	IconArrowShortUp,
	IconArrowUpFill,
	IconCircleCheck,
	IconCircleX,
	IconGear,
	IconLoader,
	IconSquircleFill,
	IconX,
} from "@pierre/icons/beta";
import { Atom } from "effect/reactivity";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChatMarkdown } from "./chat-markdown";
import type { ToolInfo, TranscriptMessage, TranscriptPart } from "./protocol";
import { themePreference } from "./theme";
import { usePiSession } from "./use-pi-session";
import "./styles.css";

/** How close to the bottom (px) still counts as "at the bottom". */
const BOTTOM_THRESHOLD = 32;
const toolsDialogOpenAtom = Atom.make<boolean>(false);

/** A message projected from a pi entry: anything but a gap. */
type EntryMessage = Exclude<TranscriptMessage, { role: "gap" }>;

function ThemeSwitcher() {
	const [mode, setMode] = useAtom(themePreference);

	return (
		<select
			aria-label="Color theme"
			className="h-11 rounded-md border border-kumo-line bg-kumo-control px-1.5 text-xs text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus"
			value={mode}
			onChange={(event) => setMode(event.currentTarget.value)}
		>
			<option value="auto">Auto</option>
			<option value="light">Light</option>
			<option value="dark">Dark</option>
		</select>
	);
}

function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs leading-5 whitespace-pre-wrap break-words">
			{typeof value === "string" ? value : JSON.stringify(value, null, 2)}
		</pre>
	);
}

function ToolCallCard({
	part,
	running,
}: {
	part: Extract<TranscriptPart, { type: "tool-call" }>;
	running: boolean;
}) {
	return (
		<details className="rounded-xl border border-kumo-line bg-kumo-base">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
				{running ? (
					<IconLoader
						size={12}
						aria-hidden="true"
						className="motion-safe:animate-spin"
						color="var(--color-kumo-inactive)"
					/>
				) : (
					<IconCircleCheck size={12} aria-hidden="true" color="var(--color-kumo-success)" />
				)}
				<span className="min-w-0 flex-1 truncate text-xs font-semibold">{part.name}</span>
				<Badge variant="secondary">{running ? "Running" : "Called"}</Badge>
			</summary>
			<div className="border-t border-kumo-line px-3 py-3">
				<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
					Arguments
				</p>
				<JsonBlock value={part.arguments} />
			</div>
		</details>
	);
}

function ToolResultCard({ part }: { part: Extract<TranscriptPart, { type: "tool-result" }> }) {
	const text = part.content
		.filter((content) => content.type === "text")
		.map((content) => (content.type === "text" ? content.text : ""))
		.join("\n");
	const images = part.content.filter((content) => content.type === "image");
	return (
		<details className="rounded-xl border border-kumo-line bg-kumo-base">
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
				{part.error ? (
					<IconCircleX size={12} aria-hidden="true" color="var(--color-kumo-danger)" />
				) : (
					<IconCircleCheck size={12} aria-hidden="true" color="var(--color-kumo-success)" />
				)}
				<span className="min-w-0 flex-1 truncate text-xs">
					<span className="font-semibold">{part.name}</span>
					{text ? <span className="ml-2 text-kumo-subtle">{text}</span> : null}
				</span>
				<Badge variant={part.error ? "error" : "secondary"}>{part.error ? "Failed" : "Done"}</Badge>
			</summary>
			<div className="space-y-3 border-t border-kumo-line px-3 py-3">
				{text ? (
					<div>
						<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
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
				{part.details !== undefined ? (
					<div>
						<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-kumo-inactive">
							Details
						</p>
						<JsonBlock value={part.details} />
					</div>
				) : null}
			</div>
		</details>
	);
}

function AssistantPart({
	part,
	running,
	streaming,
}: {
	part: TranscriptPart;
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
		case "thinking":
			return (
				<details className="rounded-xl border border-kumo-line px-3 py-2">
					<summary className="cursor-pointer list-none text-xs font-semibold text-kumo-subtle">
						Thinking
					</summary>
					<p className="mt-2 whitespace-pre-wrap text-xs italic leading-5 text-kumo-subtle">
						{part.text}
					</p>
				</details>
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

function UserMessage({ message }: { message: EntryMessage }) {
	const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
	return (
		<div className="flex justify-end">
			<div className="min-w-0 max-w-[85%] whitespace-pre-wrap wrap-anywhere rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-sm leading-relaxed text-kumo-inverse">
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
	message: EntryMessage;
	streaming?: boolean;
	runningTools: readonly string[];
}) {
	return (
		<div className="flex items-start gap-3">
			<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-(--pierre-on-accent)">
				<IconAgentFill aria-hidden="true" />
			</div>
			<div className="min-w-0 flex-1 space-y-3">
				{message.parts.map((part, index) => (
					<AssistantPart
						key={`${message.id}-${index}`}
						part={part}
						streaming={streaming && index === message.parts.length - 1}
						running={streaming && part.type === "tool-call" && runningTools.includes(part.name)}
					/>
				))}
				{streaming ? <span className="streaming-cursor" /> : null}
				{message.error ? (
					<div
						role="alert"
						className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
					>
						{message.error}
					</div>
				) : null}
			</div>
		</div>
	);
}

function ToolMessage({ message }: { message: EntryMessage }) {
	return (
		<div className="ml-11 space-y-2">
			{message.parts.map((part, index) =>
				part.type === "tool-result" ? (
					<ToolResultCard key={`${message.id}-${index}`} part={part} />
				) : null,
			)}
		</div>
	);
}

/** A compaction: the model now reads this summary instead of what came before. */
function SummaryNotice({ message }: { message: EntryMessage }) {
	const summary = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
	return (
		<details className="group text-center text-xs text-kumo-inactive">
			<summary className="cursor-pointer list-none hover:text-kumo-subtle">
				Earlier messages summarized
				<span className="group-open:hidden"> · Show summary</span>
			</summary>
			<div className="mt-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-left">
				<ChatMarkdown className="chat-summary text-xs leading-5 text-kumo-subtle" mode="static">
					{summary}
				</ChatMarkdown>
			</div>
		</details>
	);
}

function Message({
	message,
	streaming = false,
	runningTools,
	loading = false,
	onFillGap,
}: {
	message: TranscriptMessage;
	streaming?: boolean;
	runningTools: readonly string[];
	loading?: boolean;
	onFillGap?: (gap: Extract<TranscriptMessage, { role: "gap" }>) => void;
}) {
	switch (message.role) {
		case "user":
			return <UserMessage message={message} />;
		case "assistant":
			return (
				<AssistantMessage message={message} streaming={streaming} runningTools={runningTools} />
			);
		case "tool":
			return <ToolMessage message={message} />;
		case "notice":
			return message.parts.length === 0 ? null : (
				<p className="text-center text-xs text-kumo-inactive">
					{message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
				</p>
			);
		case "summary":
			return <SummaryNotice message={message} />;
		case "gap":
			// Entries this tab missed while it was away.
			return (
				<div className="flex justify-center">
					<Button
						variant="ghost"
						size="sm"
						disabled={loading || !onFillGap}
						aria-busy={loading}
						icon={
							loading ? (
								<IconLoader size={12} aria-hidden="true" className="motion-safe:animate-spin" />
							) : undefined
						}
						onClick={() => onFillGap?.(message)}
					>
						Load missing messages
					</Button>
				</div>
			);
	}
}

function ToolsDialog({
	tools,
	activeTools,
}: {
	tools: readonly ToolInfo[];
	activeTools: readonly string[];
}) {
	return (
		<Dialog className="tools-dialog z-20 flex flex-col overflow-hidden">
			<div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
				<Dialog.Title className="text-sm font-semibold">Tools</Dialog.Title>
				<Dialog.Close
					render={
						<Button
							variant="ghost"
							shape="square"
							className="size-11"
							aria-label="Close tools"
							icon={<IconX aria-hidden="true" />}
						/>
					}
				/>
			</div>
			<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
				{tools.map((tool) => (
					<Surface key={tool.name} className="rounded-lg p-3 ring ring-kumo-line">
						<div className="flex items-center gap-2">
							{activeTools.includes(tool.name) ? (
								<IconLoader
									size={12}
									aria-hidden="true"
									className="motion-safe:animate-spin"
									color="var(--color-kumo-accent)"
								/>
							) : (
								<IconGear size={12} aria-hidden="true" color="var(--color-kumo-inactive)" />
							)}
							<code className="text-xs font-semibold">{tool.name}</code>
						</div>
						<p className="mt-1 text-xs text-kumo-subtle">{tool.description}</p>
					</Surface>
				))}
			</div>
		</Dialog>
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
		transcriptStatus,
		messages,
		earlier,
		loading,
		live,
		running,
		tools: running_,
		catalog,
		queued,
		retry,
		error,
		historyError,
		submission,
		unconfirmedSubmissions,
		composer: { text: prompt, canSubmit, submitting },
		editPrompt: setPrompt,
		submit: submitPrompt,
		retrySubmit,
		retryWatch,
		abort,
		loadEarlier,
		fillGap,
	} = usePiSession();
	const runningTools = running_.map((tool) => tool.name);
	const newestId = messages.at(-1)?.id;
	const oldestId = messages[0]?.id;

	// Follow new messages, not the earlier ones loading above.
	useEffect(() => {
		if (following.current) {
			endRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [newestId, live, running]);

	// Scrolling up stops following; scrolling back to the bottom resumes it.
	const onScroll = () => {
		const scroller = scrollRef.current;
		if (scroller === null) return;
		const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
		if (fromBottom <= BOTTOM_THRESHOLD) following.current = true;
		else if (scroller.scrollTop < lastScrollTop.current - 1) {
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
		if (!loading) keepFromBottom.current = null;
	}, [oldestId, loading]);

	const showEarlier = () => {
		const scroller = scrollRef.current;
		if (scroller !== null) {
			keepFromBottom.current = scroller.scrollHeight - scroller.scrollTop;
		}
		loadEarlier();
	};

	const connected = status === "open";
	const synced = connected && transcriptStatus === "synced";

	/** While a run is going, Enter queues a follow-up and Steer joins the run. */
	const submit = (whenBusy: "followUp" | "steer" = "followUp") => {
		if (!canSubmit) return;
		// Sending a message always brings the conversation back to the bottom.
		following.current = true;
		submitPrompt(whenBusy);
	};

	const empty = synced && messages.length === 0 && !earlier && !live && !running;
	const connectionLabel = synced
		? "Live"
		: connected
			? "Syncing"
			: status === "connecting"
				? "Connecting"
				: "Reconnecting";
	return (
		<Dialog.Root open={toolsDialogOpen} onOpenChange={setToolsDialogOpen}>
			<section
				className="chat-layout flex h-dvh min-w-0 flex-col overflow-hidden bg-kumo-elevated text-kumo-default"
				aria-label="Chat"
			>
				<header className="shrink-0 border-b border-kumo-line bg-kumo-base">
					<div className="mx-auto flex min-h-15 max-w-3xl items-center justify-between gap-2 px-3 py-2 sm:px-5">
						<div className="flex min-w-0 items-center gap-2">
							<div className="hidden size-8 shrink-0 items-center justify-center rounded-xl bg-kumo-brand text-(--pierre-on-accent) min-[23.4375rem]:flex">
								<IconAgentFill size={24} aria-hidden="true" />
							</div>
							<h1 className="text-base font-semibold">Trajan</h1>
						</div>
						<div className="flex shrink-0 items-center gap-1 sm:gap-2">
							{connected && transcriptStatus === "failed" ? (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="min-h-11"
									onClick={retryWatch}
								>
									Retry sync
								</Button>
							) : (
								<Badge variant={synced ? "success" : "secondary"}>{connectionLabel}</Badge>
							)}
							<Dialog.Trigger
								render={
									<Button
										variant="ghost"
										shape="square"
										className="size-11"
										aria-label="Tools"
										icon={<IconGear aria-hidden="true" />}
									/>
								}
							/>
							<ThemeSwitcher />
						</div>
					</div>
				</header>

				<main ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
						{empty ? <Empty className="py-10 sm:py-16" title="What can I help with?" /> : null}

						{earlier ? (
							<div className="flex justify-center">
								<Button
									variant="ghost"
									size="sm"
									icon={
										loading ? (
											<IconLoader
												size={12}
												aria-hidden="true"
												className="motion-safe:animate-spin"
											/>
										) : (
											<IconArrowShortUp size={12} aria-hidden="true" />
										)
									}
									disabled={loading || !synced}
									aria-busy={loading}
									onClick={showEarlier}
								>
									Load earlier messages
								</Button>
							</div>
						) : null}

						{messages.map((message) => (
							<Message
								key={message.id}
								message={message}
								runningTools={runningTools}
								loading={loading}
								onFillGap={synced ? fillGap : undefined}
							/>
						))}

						{live ? <Message message={live} streaming runningTools={runningTools} /> : null}

						{running && !live ? (
							<div className="flex items-start gap-3">
								<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-kumo-brand text-(--pierre-on-accent)">
									<IconAgentFill aria-hidden="true" />
								</div>
								<Surface className="rounded-xl px-4 py-3 ring ring-kumo-line">
									<div className="flex items-center gap-2 text-sm text-kumo-subtle">
										<IconLoader aria-hidden="true" className="motion-safe:animate-spin" />
										{retry
											? `Retrying: ${retry.error}`
											: runningTools.length > 0
												? `Running ${runningTools.join(", ")}`
												: "Waiting for the model"}
									</div>
								</Surface>
							</div>
						) : null}

						{running_.map((tool) =>
							tool.output ? (
								<pre
									key={tool.callId}
									className="ml-11 max-h-40 overflow-auto rounded-lg bg-kumo-elevated p-2.5 text-xs"
								>
									{tool.output}
								</pre>
							) : null,
						)}

						{queued > 0 ? (
							<p className="ml-11 text-xs text-kumo-subtle">{queued} queued behind this run</p>
						) : null}

						{error ? (
							<div
								role="alert"
								className="rounded-xl bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger"
							>
								{error}
							</div>
						) : null}

						<div ref={endRef} />
					</div>
				</main>

				<div className="shrink-0 border-t border-kumo-line bg-kumo-base">
					{unconfirmedSubmissions.map(({ id, input }) => (
						<div key={id} className="mx-auto flex max-w-3xl items-center gap-3 px-5 pt-3">
							<p role="status" className="flex-1 truncate text-sm text-kumo-subtle">
								Couldn’t confirm delivery{typeof input === "string" ? ` of “${input}”` : ""}.
							</p>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="min-h-11"
								disabled={!connected}
								onClick={() => retrySubmit(id)}
							>
								Retry sending
							</Button>
						</div>
					))}
					{submission?.status === "rejected" ? (
						<p role="alert" className="mx-auto max-w-3xl px-5 pt-3 text-sm text-kumo-danger">
							{submission.message}
						</p>
					) : null}
					{historyError ? (
						<p role="alert" className="mx-auto max-w-3xl px-5 pt-3 text-sm text-kumo-danger">
							{historyError}
						</p>
					) : null}
					<form
						aria-busy={submitting}
						onSubmit={(event) => {
							event.preventDefault();
							submit();
						}}
						className="mx-auto max-w-3xl px-5 pt-3 pb-3 sm:pt-4 sm:pb-0"
					>
						<div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm transition-shadow focus-within:border-transparent focus-within:ring-2 focus-within:ring-kumo-focus">
							<InputArea
								value={prompt}
								onValueChange={setPrompt}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										submit();
									}
								}}
								placeholder={running ? "Add a follow-up" : "Message Trajan"}
								aria-label="Message Trajan"
								disabled={!connected}
								rows={2}
								className="chat-composer min-w-0 flex-1 !bg-transparent !shadow-none !ring-0 !outline-none focus:!ring-0"
							/>
							{running ? (
								<div className="mb-0.5 flex gap-1.5">
									<Button
										type="button"
										variant="secondary"
										size="sm"
										aria-label="Steer"
										className="min-h-11"
										disabled={!canSubmit}
										onClick={() => submit("steer")}
									>
										Steer
									</Button>
									<Button
										type="button"
										variant="secondary"
										shape="square"
										aria-label="Stop"
										className="size-11"
										onClick={abort}
										icon={<IconSquircleFill size={12} aria-hidden="true" />}
									/>
								</div>
							) : (
								<Button
									type="submit"
									variant="ghost"
									shape="square"
									aria-label="Send message"
									disabled={!canSubmit}
									icon={<IconArrowUpFill aria-hidden="true" />}
									className="send-button mb-0.5 size-11"
								/>
							)}
						</div>
					</form>
					<div className="hidden px-5 py-3 text-center text-[10px] text-kumo-inactive sm:block">
						Enter to send · Shift+Enter for a new line
					</div>
				</div>
			</section>
			<ToolsDialog tools={catalog} activeTools={runningTools} />
		</Dialog.Root>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<App />);
