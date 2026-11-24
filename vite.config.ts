import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: { useTabs: true },
	lint: { extends: [recommended], options: { typeAware: true, typeCheck: true } },
});
