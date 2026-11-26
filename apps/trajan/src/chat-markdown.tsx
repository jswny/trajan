import { useAtomValue } from "@effect/atom-react";
import { Markdown } from "@pierre/words/react";
import type { MarkdownProps } from "@pierre/words/react";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { Fragment, useMemo } from "react";
import type { syntaxHighlights } from "./markdown-highlights";

type ChatMarkdownProps = Pick<MarkdownProps, "className" | "isAnimating" | "mode"> & {
	readonly children: string;
};

const plainText = Atom.make(AsyncResult.success<typeof syntaxHighlights | undefined>(undefined));
const syntaxHighlighting = Atom.make(
	Effect.tryPromise(() => import("./markdown-highlights")).pipe(
		Effect.map(({ syntaxHighlights }) => syntaxHighlights),
		Effect.catchTag("UnknownError", () =>
			Effect.logWarning("Could not load syntax highlighting").pipe(Effect.as(undefined)),
		),
	),
).pipe(Atom.keepAlive);

function useSyntaxHighlighting(enabled: boolean) {
	return AsyncResult.getOrElse(
		useAtomValue(enabled ? syntaxHighlighting : plainText),
		() => undefined,
	);
}

export function ChatMarkdown({ children, ...props }: ChatMarkdownProps) {
	// Fence markers can appear inside lists and block quotes too.
	const hasFence = children.includes("```") || children.includes("~~~");
	const plugins = useSyntaxHighlighting(hasFence)?.markdownPlugins;

	return (
		<Markdown {...props} controls={false} plugins={plugins}>
			{children}
		</Markdown>
	);
}

export function ToolCode({
	text,
	language,
	preserveLines = false,
}: {
	text: string;
	language?: string;
	preserveLines?: boolean;
}) {
	const highlighting = useSyntaxHighlighting(Boolean(language));
	const lines = useMemo(
		() => (language ? highlighting?.highlight(text, language) : undefined),
		[highlighting, language, text],
	);
	const lineBreaks = lines && text.includes("\r\n") ? text.match(/\r?\n/g) : null;
	return (
		<pre
			className={`max-h-40 overflow-auto rounded-(--chat-inset-radius) bg-canvas p-2.5 text-xs leading-5 ${preserveLines ? "whitespace-pre" : "whitespace-pre-wrap wrap-anywhere"}`}
		>
			<code>
				{lines?.map((line, index) => (
					<Fragment key={index}>
						{index > 0 ? (lineBreaks?.[index - 1] ?? "\n") : null}
						{line.map(({ content, offset, htmlStyle }) => (
							<span key={offset} style={{ color: htmlStyle?.color }}>
								{content}
							</span>
						))}
					</Fragment>
				)) ?? text}
			</code>
		</pre>
	);
}
