import { readFileSync } from "node:fs";
import path from "node:path";
import { BuildOutputWorkerConfigSchema } from "@cloudflare/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

const testsDir = import.meta.dirname;
const workerTests = path.join(testsDir, "**/*.workers.test.ts");
const sandboxOutput = path.resolve(
	testsDir,
	"../../../code-mode-sandbox/.cloudflare/output/v1/workers/default",
);
const sandboxBundle = path.join(sandboxOutput, "bundle");
const sandbox = BuildOutputWorkerConfigSchema.parse(
	JSON.parse(readFileSync(path.join(sandboxOutput, "worker.config.json"), "utf8")),
);
const manifest = sandbox.manifest;
if (manifest?.type !== "partial") {
	throw new Error("Expected the built Code Mode sandbox module manifest.");
}
const wasm = Object.entries(manifest.modules ?? {})
	.filter(([, module]) => module.type === "wasm")
	.map(([file]) => ({ type: "CompiledWasm" as const, path: path.join(sandboxBundle, file) }));

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "trajan-unit",
					include: [path.join(testsDir, "**/*.test.ts")],
					exclude: [workerTests],
				},
			},
			{
				plugins: [
					cloudflareTest({
						config: "src/tests/cloudflare.config.ts",
						miniflare: {
							workers: [
								{
									name: sandbox.name,
									compatibilityDate: sandbox.compatibilityDate,
									modulesRoot: sandboxBundle,
									modules: [
										{
											type: "ESModule",
											path: path.join(sandboxBundle, manifest.mainModule),
										},
										...wasm,
									],
									durableObjects: {
										CodemodeSandbox: { className: "CodemodeSandbox", useSQLite: true },
									},
								},
							],
						},
					}),
				],
				test: {
					name: "trajan-workers",
					include: [workerTests],
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
		],
		// Workerd also reports the deliberately injected reset from the aborted task.
		onUnhandledError: (error) =>
			!(
				"durableObjectReset" in error &&
				error.durableObjectReset === true &&
				error.message === "Forced chat fixture restart"
			),
	},
});
