import { IconChevron } from "@pierre/icons/beta";
import { lazy, Suspense, useState } from "react";
import { ToolCode } from "./chat-markdown";
import type { ChatTool } from "./chat-view";
import type { ToolActivity, ToolActivityPreview } from "./chat/tool-presentation";
import { ExecScript } from "./exec-script";

const FileDiff = lazy(() => import("./file-diff"));

const toolResultLabel = { completed: "Done", failed: "Failed", unknown: "Outcome unknown" };

export function ToolCard({ message, onInspect }: { message: ChatTool; onInspect: () => void }) {
	const [open, setOpen] = useState(false);
	const { argument, name, result, activity } = message;
	const content =
		result?.content.filter((part) => part.type === "image" || part.text.length > 0) ?? [];
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
				{content.length > 0 ? (
					<div className="space-y-2">
						{content.some(({ type }) => type !== "image") ? (
							<p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Result</p>
						) : null}
						{content.map((part, index) =>
							part.type === "image" ? (
								<img
									key={index}
									src={`data:${part.mimeType};base64,${part.data}`}
									alt={`${name} output`}
									className="max-w-full rounded-(--chat-inset-radius)"
								/>
							) : (
								<ToolCode
									key={index}
									text={part.text}
									language={open && part.type === "json" ? "json" : undefined}
								/>
							),
						)}
					</div>
				) : null}
				{argument?.type === "script" ? (
					<ExecScript source={argument.source} open={open} onInspect={onInspect} />
				) : argument ? (
					<div>
						<p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
							Arguments
						</p>
						<ToolCode text={argument.source} language={open ? "json" : undefined} />
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
		<ul role="list" aria-label="Tool calls" className="space-y-1">
			{activity.map((entry) => (
				<li key={entry.id} className="min-w-0">
					<ToolActivityRow entry={entry} onInspect={onInspect} />
				</li>
			))}
		</ul>
	);
}
