import { bindings, defineConfig, exports } from "cf/config";
import { sandboxWorker } from "../../../code-mode-sandbox/cloudflare.config.ts";
// oxlint-disable-next-line import/no-namespace -- The cf-worker namespace import preserves the typed Durable Object exports.
import * as entrypoint from "./worker.ts" with { type: "cf-worker" };

export default defineConfig(() => ({
	worker: {
		name: "trajan-test",
		entrypoint,
		compatibilityDate: "2026-11-16",
		compatibilityFlags: ["nodejs_compat"],
		env: {
			CODE_MODE_SANDBOX: bindings.durableObject({
				worker: sandboxWorker,
				exportName: "CodemodeSandbox",
			}),
			CHAT_TEST: bindings.durableObject({
				worker: "trajan-test",
				exportName: "ChatTestObject",
			}),
		},
		exports: {
			ChatTestObject: exports.durableObject({ storage: "sqlite" }),
		},
	},
}));
