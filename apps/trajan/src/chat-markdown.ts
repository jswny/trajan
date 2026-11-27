import { Component, Mount } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { createDomRenderer } from "@pierre/words/html";
import { Effect, Schema, Stream } from "effect";

const loadHighlights = Effect.tryPromise(() => import("./markdown-highlights")).pipe(
	Effect.map(({ syntaxHighlights }) => syntaxHighlights),
	Effect.orElseSucceed(() => undefined),
);

const renderMarkdown = Mount.make(
	"RenderChatMarkdown",
	{ args: { id: Schema.String, source: Schema.String, active: Schema.Boolean } },
	(node: HTMLDivElement, { id }, changes) =>
		Effect.gen(function* () {
			const options = { controls: false, idPrefix: `${encodeURIComponent(id)}-` } as const;
			const renderer = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const instance = createDomRenderer(node, options);
					instance.connect();
					return instance;
				}),
				(instance) => Effect.sync(() => instance.disconnect()),
			);
			let loaded = false;
			yield* Stream.runForEach(changes, ({ source, active }) =>
				Effect.gen(function* () {
					renderer.update(source, active, active);
					if (!loaded && (source.includes("```") || source.includes("~~~"))) {
						loaded = true;
						const highlights = yield* loadHighlights;
						if (highlights) {
							renderer.configure({ ...options, plugins: highlights.markdownPlugins });
							renderer.update(source, active, active);
						}
					}
				}),
			);
		}).pipe(Effect.as(Component.noop)),
);

export function ChatMarkdown<M>(h: Html.H<M>, id: string, source: string, active = false) {
	return h.div
		.attrs({ "data-markdown": "root", "data-streaming": active ? "true" : undefined })
		.class("min-w-0 text-sm leading-6")
		.onMount(renderMarkdown({ id, source, active }));
}

const renderCode = Mount.make(
	"RenderToolCode",
	{ args: { text: Schema.String, language: Schema.NullOr(Schema.String) } },
	(node: HTMLElement, _, changes) =>
		Stream.runForEach(changes, ({ text, language }) =>
			Effect.gen(function* () {
				node.textContent = text;
				if (!language) {
					return;
				}
				const highlights = yield* loadHighlights;
				const lines = highlights?.highlight(text, language);
				if (!lines) {
					return;
				}
				const lineBreaks = text.includes("\r\n") ? text.match(/\r?\n/g) : null;
				const fragment = document.createDocumentFragment();
				for (const [index, tokens] of lines.entries()) {
					if (index > 0) {
						fragment.append(lineBreaks?.[index - 1] ?? "\n");
					}
					for (const { content, htmlStyle } of tokens) {
						const span = document.createElement("span");
						span.textContent = content;
						if (htmlStyle?.color) {
							span.style.color = htmlStyle.color;
						}
						fragment.append(span);
					}
				}
				node.replaceChildren(fragment);
			}),
		).pipe(Effect.as(Component.noop)),
);

export function ToolCode<M>(h: Html.H<M>, text: string, language?: string, preserveLines = false) {
	const whitespace = preserveLines ? "whitespace-pre" : "whitespace-pre-wrap wrap-anywhere";
	return h.pre
		.class(
			`max-h-40 overflow-auto rounded-(--chat-inset-radius) bg-canvas p-2.5 text-xs leading-5 ${whitespace}`,
		)
		.children(h.code.onMount(renderCode({ text, language: language ?? null })));
}
