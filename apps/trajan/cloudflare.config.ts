import { bindings, defineConfig, exports } from "cf/config";
import { sandboxWorker } from "../code-mode-sandbox/cloudflare.config.ts";
// oxlint-disable-next-line import/no-namespace -- The cf-worker namespace import preserves the typed Durable Object exports.
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

// Use npm run deploy --workspace=@trajan/app as the Workers Builds deploy command.
// This deploys the sandbox first so the cross-Worker binding resolves on initial deployment.
// Workers Builds injects Trajan's target name and tag. Apply them only to Trajan's deploy.
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
			...(!development && { domains: ["trajan.j1.io"] }),
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*"],
			},
			env: {
				AI: bindings.ai({ dev: { remote: true } }),
				BROWSER: bindings.browser({ dev: { remote: true } }),
				CODE_MODE_SANDBOX: bindings.durableObject({
					worker: sandboxWorker,
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
