import { execFileSync } from "node:child_process";

const name = "trajan-codemode";
const env = { ...process.env, CLOUDFLARE_CI_OVERRIDE_WORKER_NAME: name };

// Workers Builds supplies the main Worker's tag. Resolve the already provisioned
// sandbox's tag so cf can verify this deploy against the selected Worker too.
if (env.CLOUDFLARE_CI_MATCH_WORKER_TAG || env.WRANGLER_CI_MATCH_TAG) {
	const worker = JSON.parse(execFileSync("cf", ["workers", "get", name], { encoding: "utf8" }));
	if (worker.name !== name || typeof worker.id !== "string" || !worker.id) {
		throw new Error(`Could not resolve the Worker tag for ${name}`);
	}
	env.CLOUDFLARE_CI_MATCH_WORKER_TAG = worker.id;
}

const args = ["deploy", "--prebuilt", "--worker", name, "--force"];
if (process.argv.includes("--dry-run")) args.push("--dry-run");
execFileSync("cf", args, { env, stdio: "inherit" });
