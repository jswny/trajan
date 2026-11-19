import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "trajan-test",
		entrypoint,
		compatibilityDate: "2026-11-16",
		compatibilityFlags: ["nodejs_compat"],
		env: {
			LOADER: bindings.workerLoader(),
			PI_HARNESS_TEST: bindings.durableObject({
				worker: "trajan-test",
				exportName: "PiHarnessTestObject",
			}),
		},
		exports: { PiHarnessTestObject: exports.durableObject({ storage: "sqlite" }) },
	},
});
