import { defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/codemode-sandbox.ts" with { type: "cf-worker" };

// Workers Builds provides Trajan's name as a deploy override. The deploy script clears it
// for this Worker so cf uses the name from the selected build output.
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
