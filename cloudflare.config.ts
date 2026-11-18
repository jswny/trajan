import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "trajan",
    entrypoint,
    compatibilityDate: "2026-11-16",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    previewUrls: false,
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/agents/*"]
    },
    env: {
      AI: bindings.ai({ dev: { remote: true } }),
      LOADER: bindings.workerLoader(),
      Trajan: bindings.durableObject({ worker: "trajan", exportName: "Trajan" })
    },
    exports: { Trajan: exports.durableObject({ storage: "sqlite" }) },
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 0.01 }
    }
  }
});
