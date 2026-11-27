import { canUseWASM, FileDiff, parsePatchFiles } from "@pierre/diffs";
import type { BaseDiffOptions } from "@pierre/diffs";
import type { ThemeMode } from "./theme";

const diffOptions = {
	theme: { dark: "pierre-dark", light: "pierre-light" },
	diffStyle: "unified",
	overflow: "scroll",
	preferredHighlighter: canUseWASM() ? "highlights" : "shiki-js",
} satisfies BaseDiffOptions;

export function createFileDiff(container: HTMLElement) {
	const renderer = new FileDiff(diffOptions);
	let lastPatch: string | undefined;
	let fileDiff: ReturnType<typeof parsePatchFiles>[number]["files"][number] | undefined;
	return {
		render(patch: string, mode: typeof ThemeMode.Type) {
			if (patch !== lastPatch) {
				fileDiff = parsePatchFiles(patch)[0]?.files[0];
				lastPatch = patch;
			}
			if (!fileDiff) {
				container.textContent = "Diff preview unavailable";
				return;
			}
			renderer.setOptions({ ...diffOptions, themeType: mode === "auto" ? "system" : mode });
			renderer.render({ fileDiff, containerWrapper: container, forceRender: true });
		},
		dispose() {
			renderer.cleanUp();
		},
	};
}
