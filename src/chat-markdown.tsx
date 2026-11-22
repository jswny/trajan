import { Markdown, type MarkdownProps } from "@pierre/words/react";
import { useEffect, useState } from "react";

type ChatMarkdownProps = Pick<MarkdownProps, "className" | "isAnimating" | "mode"> & {
	readonly children: string;
};

export function ChatMarkdown({ children, ...props }: ChatMarkdownProps) {
	const [plugins, setPlugins] = useState<MarkdownProps["plugins"]>();
	// Fence markers can appear inside lists and block quotes too.
	const hasFence = children.includes("```") || children.includes("~~~");

	useEffect(() => {
		if (!hasFence) return;
		let active = true;
		void import("./markdown-highlights").then(
			({ markdownPlugins }) => {
				if (active) setPlugins(markdownPlugins);
			},
			(error: unknown) => {
				if (active) console.warn("Could not load Markdown syntax highlighting", error);
			},
		);
		return () => {
			active = false;
		};
	}, [hasFence]);

	return (
		<Markdown {...props} controls={false} plugins={plugins}>
			{children}
		</Markdown>
	);
}
