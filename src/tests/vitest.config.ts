import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const testsDir = import.meta.dirname;

export default defineConfig({
	plugins: [cloudflareTest({ config: "src/tests/cloudflare.config.ts" })],
	resolve: {
		// Resolve every pi package from this example, so the harness and the
		// tests share one copy of pi's module state.
		dedupe: [
			"@earendil-works/chord",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-durable",
			"@earendil-works/pi-telemetry",
		],
	},
	test: {
		name: "trajan",
		include: [path.join(testsDir, "**/*.test.ts")],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
