import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const testsDir = import.meta.dirname;
const workerTests = path.join(testsDir, "**/*.workers.test.ts");

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "trajan-unit",
					include: [path.join(testsDir, "**/*.test.ts")],
					exclude: [workerTests],
				},
			},
			{
				plugins: [cloudflareTest({ config: "src/tests/cloudflare.config.ts" })],
				test: {
					name: "trajan-workers",
					include: [workerTests],
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
		],
		// Workerd also reports the deliberately injected reset from the aborted task.
		onUnhandledError: (error) =>
			!(
				"durableObjectReset" in error &&
				error.durableObjectReset === true &&
				error.message === "Forced chat fixture restart"
			),
	},
});
