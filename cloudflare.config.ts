import { bindings, defineConfig, exports } from "cf/config";
import codemode from "./codemode.config.ts";
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

// The deploy script uses --force because dashboard secret updates have triggered false
// configuration conflicts in Workers Builds. See cloudflare/cf#69 and cloudflare/cf#466.
export default defineConfig(({ mode }) => {
	const development = mode === "development";
	// Vite uses this name for its Workers AI dev proxy. The production name is behind Access.
	const name = development ? "trajan-local" : "trajan";
	return {
		worker: {
			name,
			entrypoint,
			compatibilityDate: "2026-11-16",
			compatibilityFlags: ["nodejs_compat"],
			workersDev: !development,
			previewUrls: false,
			...(!development ? { domains: ["trajan.j1.io"] } : {}),
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*", "/agents/*"],
			},
			env: {
				AI: bindings.ai({ dev: { remote: true } }),
				LOADER: bindings.workerLoader(),
				CODEMODE_SANDBOX: bindings.durableObject({
					worker: codemode.worker,
					exportName: "CodemodeSandbox",
				}),
				Trajan: bindings.durableObject({ worker: name, exportName: "Trajan" }),
			},
			exports: { Trajan: exports.durableObject({ storage: "sqlite" }) },
			observability: {
				enabled: true,
				logs: { enabled: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.01 },
			},
		},
	};
});
