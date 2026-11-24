import { bindings, defineConfig, exports } from "cf/config";
import codemode from "@trajan/codemode/cloudflare.config";
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

export default defineConfig(({ mode }) => ({
	worker: {
		name: "trajan-test",
		entrypoint,
		compatibilityDate: "2026-11-16",
		compatibilityFlags: ["nodejs_compat"],
		env: {
			LOADER: bindings.workerLoader(),
			CODEMODE_SANDBOX:
				mode === "browser-smoke" &&
				bindings.durableObject({ worker: codemode.worker, exportName: "CodemodeSandbox" }),
			EFFECT_HARNESS_TEST: bindings.durableObject({
				worker: "trajan-test",
				exportName: "EffectHarnessTestObject",
			}),
			PI_HARNESS_TEST: bindings.durableObject({
				worker: "trajan-test",
				exportName: "PiHarnessTestObject",
			}),
		},
		exports: {
			EffectHarnessTestObject: exports.durableObject({ storage: "sqlite" }),
			PiHarnessTestObject: exports.durableObject({ storage: "sqlite" }),
		},
	},
}));
