import { fileURLToPath } from "node:url";
import { loadAndParseConfig } from "@cloudflare/config";
import { cloudflare } from "@cloudflare/vite-plugin";
import type { PluginConfig } from "@cloudflare/vite-plugin";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import tailwindcss from "@tailwindcss/vite";
import agents from "agents/vite";
import { defineConfig } from "vite-plus";

// Pierre ships the SVGs in its tarball, outside the package's JS export map.
const pierreIconAssets = fileURLToPath(new URL("../", import.meta.resolve("@pierre/icons")));
const sandboxPath = fileURLToPath(
	new URL("../code-mode-sandbox/cloudflare.config.ts", import.meta.url),
);

async function sandboxWorker(mode: string) {
	const { result } = await loadAndParseConfig(sandboxPath, { isPreview: false, mode });
	if (!result.success) {
		throw result.error;
	}
	if (!result.data.worker) {
		throw new Error("Missing Trajan Code Mode sandbox Worker");
	}
	return result.data.worker;
}

const paletteRoles = {
	canvas: "editor.background",
	surface: "panel.background",
	control: "input.background",
	ink: "editor.foreground",
	muted: "sideBar.foreground",
	line: "input.border",
	hover: "list.hoverBackground",
	selection: "editor.selectionBackground",
	accent: "button.background",
	"accent-hover": "button.hoverBackground",
	success: "gitDecoration.addedResourceForeground",
	danger: "gitDecoration.deletedResourceForeground",
	"plot-blue": "terminal.ansiBlue",
	"plot-green": "terminal.ansiGreen",
	"plot-violet": "gitDecoration.conflictingResourceForeground",
	"plot-yellow": "terminal.ansiYellow",
	"plot-magenta": "terminal.ansiMagenta",
	"plot-cyan": "terminal.ansiCyan",
	"plot-red": "terminal.ansiRed",
};

async function fixtureWorker(mode: "browser-smoke"): Promise<PluginConfig> {
	const fixturePath = fileURLToPath(new URL("./src/tests/cloudflare.config.ts", import.meta.url));
	const { result } = await loadAndParseConfig(fixturePath, {
		isPreview: false,
		mode,
	});
	if (!result.success) {
		throw result.error;
	}
	const worker = result.data.worker;
	if (!worker) {
		throw new Error("Missing Trajan test Worker");
	}
	return {
		config: () => ({
			worker: {
				...worker,
				assets: {
					runWorkerFirst: ["/api/*", "/__browser-smoke/*"],
				},
			},
		}),
		persistState: false,
		remoteBindings: false,
		inspectorPort: false,
		types: { generate: false },
	};
}

async function cloudflarePlugin(command: "build" | "serve", mode: string) {
	if (command === "build") {
		return cloudflare();
	}
	const fixture = mode === "browser-smoke" ? await fixtureWorker(mode) : undefined;
	return cloudflare({
		...fixture,
		auxiliaryWorkers: [{ config: await sandboxWorker(mode), devOnly: true }],
	});
}

export default defineConfig(async ({ command, mode }) => ({
	resolve: { alias: { "pierre-icon-assets": pierreIconAssets } },
	// Intentional Worker crashes during recovery tests must not obscure other test pages.
	...(mode === "browser-smoke" && { server: { hmr: { overlay: false } } }),
	plugins: [
		agents(),
		await cloudflarePlugin(command, mode),
		tailwindcss(),
		{
			name: "pierre-palette",
			transformIndexHtml() {
				const properties = Object.entries(paletteRoles).map(([role, key]) => {
					const light = pierreLight.colors[key];
					const dark = pierreDark.colors[key];
					if (!light || !dark) {
						throw new Error(`Pierre theme is missing ${key}`);
					}
					return `--pierre-${role}:${light === dark ? light : `light-dark(${light},${dark})`};`;
				});
				return [
					{ tag: "style", children: `:root{${properties.join("")}}`, injectTo: "head-prepend" },
				];
			},
		},
	],
}));
