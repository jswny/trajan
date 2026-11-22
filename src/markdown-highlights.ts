import githubDark from "@pierre/highlights/themes/github-dark";
import githubLight from "@pierre/highlights/themes/github-light";
import { createHighlightsPlugin } from "@pierre/words/highlights";

export const markdownPlugins = {
	code: createHighlightsPlugin({
		themes: { light: githubLight, dark: githubDark },
		defaultColor: "light-dark()",
	}),
};
