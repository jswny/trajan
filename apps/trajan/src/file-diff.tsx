import { useAtomValue } from "@effect/atom-react";
import { canUseWASM } from "@pierre/diffs";
import type { BaseDiffOptions } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { themePreference } from "./theme";

const diffOptions = {
	theme: { dark: "pierre-dark", light: "pierre-light" },
	diffStyle: "unified",
	overflow: "scroll",
	preferredHighlighter: canUseWASM() ? "highlights" : "shiki-js",
} satisfies BaseDiffOptions;

export default function FileDiff({ patch }: { patch: string }) {
	const theme = useAtomValue(themePreference);
	return (
		<PatchDiff
			patch={patch}
			options={{ ...diffOptions, themeType: theme === "auto" ? "system" : theme }}
		/>
	);
}
