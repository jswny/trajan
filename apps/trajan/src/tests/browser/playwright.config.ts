import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const results = join(root, "test-results");
mkdirSync(results, { recursive: true });
const runDirectory = (process.env.TRAJAN_BROWSER_RUN_DIRECTORY ??= mkdtempSync(
	join(results, "browser-"),
));

export default defineConfig({
	testDir: ".",
	outputDir: join(runDirectory, "artifacts"),
	use: { ...devices["iPhone 17 Pro"], browserName: "chromium" },
	webServer: {
		command:
			'npm run dev -- -- --mode browser-smoke --host 127.0.0.1 --port 0 --strictPort 2>&1 | tee "$TRAJAN_BROWSER_RUN_DIRECTORY/worker.log"',
		cwd: root,
		env: { CLOUDFLARE_DEV_REGISTRY_PATH: join(runDirectory, "registry") },
		wait: { stdout: /Local:\s+http:\/\/127\.0\.0\.1:(?<TRAJAN_BROWSER_PORT>\d+)\// },
		gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
	},
});
