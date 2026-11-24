import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const testsDir = import.meta.dirname;

export default defineConfig({
	plugins: [cloudflareTest({ config: "src/tests/cloudflare.config.ts" })],

	test: {
		name: "trajan",
		include: [path.join(testsDir, "**/*.test.ts")],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Workerd also reports the deliberately injected reset from the aborted task.
		onUnhandledError: (error) =>
			!(
				"durableObjectReset" in error &&
				error.durableObjectReset === true &&
				error.message === "Forced Effect harness fixture restart"
			),
	},
});
