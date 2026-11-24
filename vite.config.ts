import cloudflare from "@cloudflare/oxlint-config/vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: { useTabs: true },
	lint: {
		extends: [cloudflare, recommended],
		env: cloudflare.env,
		ignorePatterns: cloudflare.ignorePatterns,
		options: { typeAware: true, typeCheck: true },
		rules: {
			// Trajan intentionally uses Effect's unstable atoms, AI toolkit, and test helpers.
			"effecttsgo/unstable-api-usage": "off",
		},
	},
});
