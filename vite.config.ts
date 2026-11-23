import { fileURLToPath } from "node:url";
import { loadAndParseConfig } from "@cloudflare/config";
import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
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

async function browserSmokeWorker(): Promise<PluginConfig> {
	const fixturePath = fileURLToPath(new URL("./src/tests/cloudflare.config.ts", import.meta.url));
	const { result } = await loadAndParseConfig(fixturePath, {
		isPreview: false,
		mode: "browser-smoke",
	});
	if (!result.success) throw result.error;
	const worker = result.data.worker;
	if (!worker) throw new Error("Missing browser smoke test Worker");
	return {
		config: () => ({
			worker: { ...worker, assets: { runWorkerFirst: ["/agents/*", "/__browser-smoke/*"] } },
		}),
		persistState: false,
		remoteBindings: false,
		inspectorPort: false,
		types: { generate: false },
	};
}

async function cloudflareWorkers(command: string, mode: string): Promise<PluginConfig> {
	const sandboxPath = fileURLToPath(new URL("./codemode.config.ts", import.meta.url));
	const { result } = await loadAndParseConfig(sandboxPath, { isPreview: false, mode });
	if (!result.success) throw result.error;
	const sandbox = result.data.worker;
	if (!sandbox) throw new Error("Missing Pi Code Mode sandbox Worker");
	const browserSmoke = command === "serve" && mode === "browser-smoke";
	return {
		...(browserSmoke ? await browserSmokeWorker() : {}),
		auxiliaryWorkers: [{ config: sandbox }],
	};
}

export default defineConfig(async ({ command, mode }) => ({
	plugins: [
		agents(),
		react(),
		cloudflare(await cloudflareWorkers(command, mode)),
		tailwindcss(),
		{
			name: "pierre-palette",
			transformIndexHtml() {
				const properties = Object.entries(paletteRoles).map(([role, key]) => {
					const light = pierreLight.colors[key];
					const dark = pierreDark.colors[key];
					if (!light || !dark) throw new Error(`Pierre theme is missing ${key}`);
					return `--pierre-${role}:${light === dark ? light : `light-dark(${light},${dark})`};`;
				});
				return [
					{ tag: "style", children: `:root{${properties.join("")}}`, injectTo: "head-prepend" },
				];
			},
		},
	],
	fmt: { useTabs: true },
	lint: { options: { typeAware: true, typeCheck: true } },
	resolve: {
		dedupe: [
			"react",
			"react-dom",
			"@earendil-works/chord",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-durable",
			"@earendil-works/pi-telemetry",
		],
	},
}));
