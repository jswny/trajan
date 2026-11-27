import { Component, Mount, Subscription, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { ToolCode } from "./chat-markdown";
import { ChatTool } from "./chat-view";
import { ToolActivity } from "./chat/tool-presentation";
import type { ToolActivityPreview } from "./chat/tool-presentation";
import { Icon } from "./icons";
import { themePreference } from "./theme";
import { observeAtom } from "./ui-atoms";

const labels = { completed: "Done", failed: "Failed", unknown: "Outcome unknown" };
const activityLabels = {
	running: "Running",
	completed: "Succeeded",
	failed: "Failed",
	interrupted: "Interrupted",
};
const sectionLabel = "text-[10px] font-semibold uppercase tracking-wide text-muted";
const summaryFocus =
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring [&::-webkit-details-marker]:hidden";

const ScriptMessage = UiSchema.TaggedEnum({
	Formatted: { source: Schema.String, formatted: Schema.String },
	ToggleOriginal: {},
});
const ExecScript = Html.component({
	name: "ExecScript",
	props: Schema.Struct({ source: Schema.String }),
	model: Schema.Struct({
		formatted: Schema.NullOr(Schema.Struct({ source: Schema.String, formatted: Schema.String })),
		original: Schema.Boolean,
	}),
	message: ScriptMessage,
}).make({
	init: () => ({ formatted: null, original: false }),
	update: ({ model }, message) =>
		message._tag === "Formatted"
			? { ...model, formatted: { source: message.source, formatted: message.formatted } }
			: { ...model, original: !model.original },
	subscriptions: ({ props }) => [
		Subscription.make("format-script", props.source, (source) =>
			Stream.fromEffect(
				Effect.tryPromise(async () => {
					const { formatExecScript } = await import("./format-exec-script");
					return ScriptMessage.Formatted({ source, formatted: await formatExecScript(source) });
				}).pipe(Effect.orElseSucceed(() => ScriptMessage.Formatted({ source, formatted: source }))),
			),
		),
	],
	view: (h, model) => {
		const { props } = h;
		const formatted =
			model.formatted?.source === props.source ? model.formatted.formatted : props.source;
		return h.div(
			h.div.class("mb-1 flex items-center justify-between gap-2").children(
				h.p.class(sectionLabel).children("Script"),
				formatted !== props.source &&
					h.button
						.attrs({ type: "button", "aria-pressed": String(model.original), "data-inspect": "" })
						.class(
							"chat-button chat-compact-control px-3 text-xs text-muted aria-pressed:bg-control aria-pressed:text-ink",
						)
						.on("click", ScriptMessage.ToggleOriginal())
						.children("Original"),
			),
			ToolCode(h, model.original ? props.source : formatted, "js", true),
		);
	},
});

const renderDiff = Mount.make(
	"RenderFileDiff",
	{ args: { patch: Schema.String } },
	(node: HTMLDivElement, _, changes) =>
		Effect.gen(function* () {
			node.textContent = "Loading diff…";
			const module = yield* Effect.tryPromise(() => import("./file-diff"));
			const renderer = yield* Effect.acquireRelease(
				Effect.sync(() => {
					node.textContent = "";
					return module.createFileDiff(node);
				}),
				(instance) => Effect.sync(() => instance.dispose()),
			);
			yield* changes.pipe(
				Stream.zipLatest(observeAtom(themePreference)),
				Stream.runForEach(([{ patch }, mode]) => Effect.sync(() => renderer.render(patch, mode))),
			);
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("Could not render file diff", cause).pipe(
					Effect.andThen(
						Effect.sync(() => {
							node.textContent = "Diff preview unavailable";
						}),
					),
				),
			),
			Effect.as(Component.noop),
		),
);

function fileLanguage(path: string) {
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (name === "dockerfile" || name === "makefile") {
		return name;
	}
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : undefined;
}

function ActivityDetail<M>(h: Html.H<M>, label: string, preview: typeof ToolActivityPreview.Type) {
	const path = preview.format === "file" ? preview.path : undefined;
	return h.div(
		h.p.class(`mb-1 ${sectionLabel}`).children(label),
		path && h.p.class("mb-1 font-mono text-xs wrap-anywhere text-muted").children(path),
		path && preview.text === ""
			? h.p.class("text-xs text-muted").children("Empty file")
			: ToolCode(
					h,
					preview.text || '""',
					path ? fileLanguage(path) : preview.format === "json" ? "json" : undefined,
					path !== undefined,
				),
		preview.truncated && h.p.class("mt-1 text-xs text-muted").children("Preview truncated"),
	);
}

const DisclosureMessage = UiSchema.TaggedEnum({ Toggled: { open: Schema.Boolean } });
const toolRow = "flex min-h-11 min-w-0 items-center gap-2 px-2.5 py-1.5 text-xs";

const ActivityRow = Html.component({
	name: "ToolActivityRow",
	props: Schema.Struct({ entry: ToolActivity }),
	model: Schema.Boolean,
	message: DisclosureMessage,
}).make({
	init: () => false,
	update: (_, { open }) => open,
	view: (h, open) => {
		const { entry } = h.props;
		const { name, status, input, output, fileChange } = entry;
		const heading = [
			h.span.class("min-w-0 flex-1 truncate font-medium").children(name),
			h.span
				.class("chat-badge")
				.attr("data-tone", status === "failed" ? "danger" : undefined)
				.children(activityLabels[status]),
		];
		if (!input && !output && !fileChange) {
			return h.div.class(toolRow).children(...heading);
		}
		const previews = [
			input && ActivityDetail(h, "Arguments", input),
			output && ActivityDetail(h, "Result", output),
		];
		return h.details
			.on("toggle", ({ open }) => DisclosureMessage.Toggled({ open }))
			.class("group/call rounded-(--chat-inset-radius) border border-transparent open:border-line")
			.children(
				h.summary
					.class(
						`${toolRow} cursor-pointer list-none rounded-(--chat-inset-radius) hover:bg-hover ${summaryFocus}`,
					)
					.children(...heading, Icon(h, "chevron", 12, "text-muted group-open/call:rotate-180")),
				open &&
					h.div.class("space-y-3 px-2.5 pb-2.5").children(
						fileChange &&
							h.section
								.attr("aria-label", "File changes")
								.class(
									"max-h-56 min-w-0 overflow-auto rounded-(--chat-inset-radius) bg-canvas [--diffs-font-size:0.75rem]",
								)
								.children(
									fileChange.diff
										? h.div.onMount(renderDiff({ patch: fileChange.diff }))
										: h.div
												.class("space-y-1 px-2.5 py-2 text-xs")
												.children(
													h.p.class("font-mono wrap-anywhere").children(fileChange.path),
													h.p
														.class("text-muted")
														.children(
															fileChange.kind === "unchanged"
																? "No content changes"
																: "Diff preview unavailable",
														),
												),
								),
						fileChange && (input || output)
							? h.details(
									h.summary
										.class(
											"w-fit cursor-pointer rounded-(--chat-inset-radius) px-2.5 py-1.5 text-xs text-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus-ring",
										)
										.children("Arguments and receipt"),
									h.div.class("mt-2 space-y-3").children(...previews),
								)
							: previews,
					),
			);
	},
});

export const ToolCard = Html.component({
	name: "ToolCard",
	props: Schema.Struct({ message: ChatTool }),
	model: Schema.Boolean,
	message: DisclosureMessage,
}).make({
	init: () => false,
	update: (_, { open }) => open,
	view: (h, open) => {
		const { argument, name, result, activity } = h.props.message;
		const content =
			result?.content.filter((part) => part.type === "image" || part.text.length > 0) ?? [];
		const uncertain = (result?.uncertainEffects?.length ?? 0) > 0;
		const failed = result?.status === "failed" || result?.status === "unknown" || uncertain;
		const step = !result && activity.at(-1);
		return h.details
			.attr("data-chat-entry", "")
			.on("toggle", ({ open }) => DisclosureMessage.Toggled({ open }))
			.class("chat-tool-card group w-fit max-w-full border border-line bg-surface open:w-full")
			.children(
				h.summary
					.class(`flex cursor-pointer list-none items-center gap-2 px-3 py-2 ${summaryFocus}`)
					.children(
						h.span
							.class("flex min-w-0 flex-1 items-center gap-2 text-xs")
							.children(
								h.span.class("shrink-0 font-semibold").children(name),
								step && h.span.class("truncate text-muted").children(step.name),
							),
						h.span
							.class("chat-badge")
							.attr("data-tone", failed ? "danger" : undefined)
							.children(uncertain ? "Outcome unknown" : result ? labels[result.status] : "Running"),
						Icon(h, "chevron", 12, "text-muted group-open:rotate-180"),
					),
				open &&
					h.div.class("space-y-3 border-t border-line px-3 py-3").children(
						...(result?.uncertainEffects ?? []).map(({ id, name, message }) =>
							h.p
								.key(id)
								.class(
									"wrap-anywhere rounded-(--chat-inset-radius) bg-danger/10 px-2.5 py-2 text-xs text-danger",
								)
								.children(`${name}. ${message}`),
						),
						activity.length > 0 &&
							h.ul
								.attrs({ role: "list", "aria-label": "Tool calls" })
								.class("space-y-1")
								.children(
									...activity.map((entry) =>
										h.li
											.key(entry.id)
											.class("min-w-0")
											.children(ActivityRow(h, { key: entry.id, props: { entry } })),
									),
								),
						content.length > 0 &&
							h.div.class("space-y-2").children(
								content.some(({ type }) => type !== "image") &&
									h.p.class(sectionLabel).children("Result"),
								...content.map((part) =>
									part.type === "image"
										? h.img
												.attrs({
													src: `data:${part.mimeType};base64,${part.data}`,
													alt: `${name} output`,
												})
												.class("max-w-full rounded-(--chat-inset-radius)")
										: ToolCode(h, part.text, part.type === "json" ? "json" : undefined),
								),
							),
						argument?.type === "script"
							? ExecScript(h, { props: { source: argument.source } })
							: argument &&
									h.div(
										h.p.class(`mb-1 ${sectionLabel}`).children("Arguments"),
										ToolCode(h, argument.source, "json"),
									),
					),
			);
	},
});
