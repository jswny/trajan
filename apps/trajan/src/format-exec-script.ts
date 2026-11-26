import babel from "prettier/plugins/babel";
import estree from "prettier/plugins/estree";
import { format } from "prettier/standalone";

export function formatExecScript(source: string) {
	return format(source, {
		parser: "babel",
		plugins: [babel, estree],
		printWidth: 72,
		embeddedLanguageFormatting: "off",
	});
}
