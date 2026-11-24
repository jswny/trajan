import { fileURLToPath } from "node:url";
import { loadAndParseConfig } from "@cloudflare/config";
import { cloudflare } from "@cloudflare/vite-plugin";
import type { PluginConfig } from "@cloudflare/vite-plugin";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite-plus";

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

export default defineConfig(async ({ command, mode }) => ({
	// Intentional Worker crashes during recovery tests must not obscure other test pages.
	server: mode === "browser-smoke" ? { hmr: { overlay: false } } : undefined,
	plugins: [
		agents(),
		react(),
		cloudflare(command === "serve" && mode === "browser-smoke" ? await fixtureWorker(mode) : {}),
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
	resolve: {
		dedupe: ["react", "react-dom"],
	},
}));
