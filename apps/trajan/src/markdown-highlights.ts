import pierreDark from "@pierre/highlights/themes/pierre-dark";
import pierreLight from "@pierre/highlights/themes/pierre-light";
import { createHighlightsPlugin } from "@pierre/words/highlights";

export const markdownPlugins = {
	code: createHighlightsPlugin({
		themes: { light: pierreLight, dark: pierreDark },
		defaultColor: "light-dark()",
	}),
};
