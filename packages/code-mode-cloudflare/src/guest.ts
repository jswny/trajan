import type { WorkerEntrypoint } from "cloudflare:workers";
import type { Json } from "effect/Schema";

const runner = `
import { WorkerEntrypoint, withEnv } from "cloudflare:workers";
import script from "./script.js";

export default class extends WorkerEntrypoint {
  async run(host) {
    // Deliver results in invocation order even when the script uses Promise.all.
    let queue = Promise.resolve();
    const call = (module, name, input) => {
      const reply = queue.then(() => host.call({ module, name, input }));
      queue = reply.then(() => undefined, () => undefined);
      return reply;
    };
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let remaining = 16 * 1024;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const format = (value) => {
      if (typeof value === "string") return value;
      try { return JSON.stringify(value) ?? String(value); }
      catch { return String(value); }
    };
    const capture = (values) => {
      const bytes = encoder.encode(values.map(format).join(" ") + "\\n");
      const chunk = decoder.decode(bytes.subarray(0, remaining), { stream: bytes.length > remaining });
      truncated ||= bytes.length > remaining;
      remaining -= Math.min(bytes.length, remaining);
      return chunk;
    };
    const { log, error } = console;
    console.log = (...values) => { stdout += capture(values); };
    console.error = (...values) => { stderr += capture(values); };
    try {
      const value = (await withEnv({ call }, script)) ?? null;
      await queue;
      return stdout || stderr || truncated
        ? { value, stdout, stderr, ...(truncated && { truncated }) }
        : value;
    } finally {
      console.log = log;
      console.error = error;
      await queue;
    }
  }
}
`;

const tools = `
import { env } from "cloudflare:workers";

export async function invoke(module, name, input) {
  const reply = await env.call(module, name, input);
  if (reply.status === "returned") return reply.value;
  const error = new Error(reply.message);
  error.code = reply.status;
  throw error;
}
`;

export function loadGuest<T extends Rpc.RpcTargetBranded>(
	loader: WorkerLoader,
	source: string,
	namespaces: ReadonlyMap<string, ReadonlyArray<string>>,
) {
	const toolModules = Array.from(namespaces, ([module, names]) => {
		const exports = names.map(
			(name, index) =>
				`const tool${index} = (input = null) => invoke(${JSON.stringify(module)}, ${JSON.stringify(name)}, input); export { tool${index} as ${JSON.stringify(name)} };`,
		);
		return [
			module,
			{ js: ['import { invoke } from "./tools.js";', ...exports].join("\n") },
		] as const;
	});
	const modules = {
		"runner.js": { js: runner },
		"tools.js": { js: tools },
		"script.js": { js: source },
		...Object.fromEntries(toolModules),
	} satisfies Record<string, WorkerLoaderModule>;

	return loader
		.load({
			compatibilityDate: "2026-11-16",
			compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
			mainModule: "runner.js",
			modules,
			globalOutbound: null,
			limits: { cpuMs: 1000, subRequests: 128 },
		})
		.getEntrypoint<WorkerEntrypoint & { run(host: T): Promise<Json> }>();
}
