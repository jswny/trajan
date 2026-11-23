import { useAtomValue } from "@effect/atom-react";
import { Markdown, type MarkdownProps } from "@pierre/words/react";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

type ChatMarkdownProps = Pick<MarkdownProps, "className" | "isAnimating" | "mode"> & {
	readonly children: string;
};

const plainMarkdown = Atom.make(AsyncResult.success<MarkdownProps["plugins"]>(undefined));
const highlightedMarkdown = Atom.make(
	Effect.tryPromise(() => import("./markdown-highlights")).pipe(
		Effect.map(({ markdownPlugins }): MarkdownProps["plugins"] => markdownPlugins),
		Effect.catch(() =>
			Effect.logWarning("Could not load Markdown syntax highlighting").pipe(Effect.as(undefined)),
		),
	),
).pipe(Atom.keepAlive);

export function ChatMarkdown({ children, ...props }: ChatMarkdownProps) {
	// Fence markers can appear inside lists and block quotes too.
	const hasFence = children.includes("```") || children.includes("~~~");
	const result = useAtomValue(hasFence ? highlightedMarkdown : plainMarkdown);
	const plugins = AsyncResult.getOrElse(result, () => undefined);

	return (
		<Markdown {...props} controls={false} plugins={plugins}>
			{children}
		</Markdown>
	);
}
