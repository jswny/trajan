import { bindings, defineConfig, exports } from "cf/config";
// oxlint-disable-next-line import/no-namespace -- The cf-worker namespace import preserves the typed Durable Object exports.
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

export default defineConfig(() => ({
	worker: {
		name: "trajan-test",
		entrypoint,
		compatibilityDate: "2026-11-16",
		compatibilityFlags: ["nodejs_compat"],
		env: {
			LOADER: bindings.workerLoader(),
			EFFECT_HARNESS_TEST: bindings.durableObject({
				worker: "trajan-test",
				exportName: "EffectHarnessTestObject",
			}),
		},
		exports: {
			EffectHarnessTestObject: exports.durableObject({ storage: "sqlite" }),
		},
	},
}));
