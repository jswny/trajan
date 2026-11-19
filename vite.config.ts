import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [agents(), react(), cloudflare(), tailwindcss()],
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
});
