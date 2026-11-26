import { codeToTokens, isSupportedLanguage } from "@pierre/highlights";
import pierreDark from "@pierre/highlights/themes/pierre-dark";
import pierreLight from "@pierre/highlights/themes/pierre-light";
import { createHighlightsPlugin } from "@pierre/words/highlights";

const themeOptions = {
	themes: { light: pierreLight, dark: pierreDark },
	defaultColor: "light-dark()",
};

export const syntaxHighlights = {
	markdownPlugins: { code: createHighlightsPlugin(themeOptions) },
	highlight(text: string, language: string) {
		return isSupportedLanguage(language)
			? codeToTokens(text, { ...themeOptions, lang: language }).tokens
			: undefined;
	},
};
