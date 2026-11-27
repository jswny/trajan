import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({ plugins: [cloudflare({ types: { generate: false } })] });
