import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const origin = "http://127.0.0.1:5177";
const root = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
	testDir: ".",
	outputDir: fileURLToPath(new URL("../../../test-results/", import.meta.url)),
	use: { ...devices["iPhone 17 Pro"], baseURL: origin, browserName: "chromium" },
	webServer: {
		command:
			"mkdir -p .cloudflare && exec npm run dev -- -- --mode browser-smoke --host 127.0.0.1 --port 5177 --strictPort > .cloudflare/browser-smoke.log 2>&1",
		cwd: root,
		env: {
			CLOUDFLARE_DEV_REGISTRY_PATH: fileURLToPath(
				new URL("../../../.cloudflare/browser-smoke-registry", import.meta.url),
			),
		},
		url: `${origin}/__browser-smoke/ready`,
		gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
	},
});
