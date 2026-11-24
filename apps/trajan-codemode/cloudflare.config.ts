import { defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

// Use npm run deploy --workspace=@trajan/codemode as the Workers Builds deploy command.
export default defineConfig({
	worker: {
		name: "trajan-codemode",
		entrypoint,
		compatibilityDate: "2026-11-16",
		compatibilityFlags: ["nodejs_compat"],
		workersDev: false,
		previewUrls: false,
		exports: { CodemodeSandbox: exports.durableObject({ storage: "sqlite" }) },
	},
});
