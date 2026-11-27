import { defineConfig, defineWorker, exports } from "cf/config";
// oxlint-disable-next-line import/no-namespace -- Keep the Worker export typed for cf.
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

export const sandboxWorker = defineWorker({
	name: "trajan-code-mode",
	entrypoint,
	compatibilityDate: "2026-11-16",
	workersDev: false,
	previewUrls: false,
	exports: { CodemodeSandbox: exports.durableObject({ storage: "sqlite" }) },
	observability: { enabled: true, traces: { enabled: true } },
});

export default defineConfig({ worker: sandboxWorker });
