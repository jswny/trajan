import { parse } from "acorn";
import { CodeModeRejected, codeModeError } from "@trajan/code-mode";
import type { CodeModeHost, GuestEvent } from "@trajan/code-mode";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { CodemodeRemote, CodemodeResult } from "@earendil-works/pi-codemode/portable";
import { Effect, Schema } from "effect";

const key = (module: string, name: string) => JSON.stringify([module, name]);

const consoleLimit = 16 * 1024;
const scriptOutput = Schema.decodeUnknownSync(
	Schema.Struct({
		value: Schema.Json,
		lines: Schema.Array(Schema.Tuple([Schema.Literals(["stdout", "stderr"]), Schema.String])),
		truncated: Schema.Boolean,
	}),
);

const captureConsole = `
  const lines = [];
  let remaining = ${consoleLimit};
  let truncated = false;
  const format = (value) => {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value) ?? String(value); }
    catch { return String(value); }
  };
  const capture = (stream) => (...values) => {
    if (!remaining) { truncated = true; return; }
    const line = values.map(format).join(" ") + "\\n";
    truncated ||= line.length > remaining;
    lines.push([stream, line.slice(0, remaining)]);
    remaining -= Math.min(line.length, remaining);
  };
  const console = Object.freeze({
    ...globalThis.console,
    log: capture("stdout"),
    error: capture("stderr"),
  });
`;

function compile(source: string, namespaces: ReadonlyMap<string, ReadonlyArray<string>>) {
	const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
	// Pick identifiers outside the author's source, including escaped identifiers.
	const identifiers = source.replaceAll(
		/\\u(?:\{([\da-f]+)\}|([\da-f]{4}))/gi,
		(_, long: string | undefined, short: string | undefined) => {
			const point = Number.parseInt(long ?? short ?? "", 16);
			return point <= 0x10_ff_ff ? String.fromCodePoint(point) : "";
		},
	);
	let prefix = "__trajan";
	while (identifiers.includes(prefix)) {
		prefix += "_";
	}
	const binding = prefix + "Bindings";
	const entry = prefix + "Entry";
	const pending = prefix + "Pending";
	const invoke = prefix + "Invoke";
	const freeze = prefix + "Freeze";
	const imports: Array<string> = [];
	const chunks: Array<string> = [];
	let from = source.startsWith("#!") ? source.indexOf("\n") + 1 || source.length : 0;
	let entryName: string | undefined;
	for (const node of program.body) {
		if (node.type === "ImportDeclaration") {
			chunks.push(source.slice(from, node.start));
			from = node.end;
			const module = String(node.source.value);
			const names = namespaces.get(module);
			if (!names) {
				throw new Error("Unknown Code Mode module " + module + ".");
			}
			const reference = (name: string) =>
				invoke + "(" + binding + "[" + JSON.stringify(key(module, name)) + "])";
			for (const specifier of node.specifiers) {
				if (specifier.type === "ImportNamespaceSpecifier") {
					const entries = names.map((name) => "[" + JSON.stringify(name) + "]:" + reference(name));
					imports.push(
						"const " + specifier.local.name + "=" + freeze + "({" + entries.join(",") + "});",
					);
				} else {
					const name =
						specifier.type === "ImportDefaultSpecifier"
							? "default"
							: specifier.imported.type === "Identifier"
								? specifier.imported.name
								: String(specifier.imported.value);
					if (!names.includes(name)) {
						throw new Error("Unknown Code Mode tool " + module + "/" + name + ".");
					}
					imports.push("const " + specifier.local.name + "=" + reference(name) + ";");
				}
			}
		} else if (node.type === "ExportDefaultDeclaration") {
			const declaration = node.declaration;
			chunks.push(source.slice(from, node.start));
			if (declaration.type === "FunctionDeclaration" && declaration.id) {
				entryName = declaration.id.name;
				chunks.push(source.slice(declaration.start, declaration.end));
			} else {
				entryName = entry;
				chunks.push(
					"const " + entry + "=(" + source.slice(declaration.start, declaration.end) + ");",
				);
			}
			from = node.end;
		} else if (node.type === "ExportNamedDeclaration" && node.declaration) {
			chunks.push(source.slice(from, node.start), source.slice(node.declaration.start, node.end));
			from = node.end;
		} else if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
			throw new Error("Code Mode supports a default function and local declarations.");
		}
	}
	if (!entryName) {
		throw new Error("Code Mode requires a default exported function.");
	}
	chunks.push(source.slice(from));
	// Keep the capture scope outside the author's module and wait for its issued calls to settle.
	return `return await (async (${binding}) => {
  "use strict";
  const ${pending} = new Set();
  const ${freeze} = Object.freeze;
  const ${invoke} = (call) => (input = null) => {
    const answer = call(input);
    const done = answer.then(() => ${pending}.delete(done), () => ${pending}.delete(done));
    ${pending}.add(done);
    return answer;
  };
  const tools = undefined;
  ${captureConsole}
  let value;
  try {
    value = await (async () => {
${imports.join("\n")}
${chunks.join("\n")}
      return (await ${entryName}()) ?? null;
    })();
  } finally {
    while (${pending}.size) await Promise.all(${pending});
  }
  return { value, lines, truncated };
})(tools);`;
}

function output(result: Extract<CodemodeResult, { ok: true }>) {
	const { value, lines, truncated } = scriptOutput(result.value);
	if (!lines.length && !truncated) {
		return value;
	}
	const streams = { stdout: "", stderr: "" };
	let remaining = consoleLimit;
	let clipped = truncated;
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	for (const [stream, text] of lines) {
		if (!remaining) {
			clipped = true;
			break;
		}
		const bytes = encoder.encode(text);
		streams[stream] += decoder.decode(bytes.subarray(0, remaining), {
			stream: bytes.length > remaining,
		});
		clipped ||= bytes.length > remaining;
		remaining -= Math.min(bytes.length, remaining);
	}
	return { value, ...streams, ...(clipped && { truncated: true }) };
}

export function quickJsGuest(
	remote: (executionId: string) => CodemodeRemote,
): CodeModeHost["prepareGuest"] {
	return (source, namespaces) =>
		Effect.try({
			try: () => {
				const code = compile(source, namespaces);
				const tools = Array.from(namespaces, ([module, names]) =>
					names.map((name) => ({ name: key(module, name), call: { module, name } })),
				).flat();
				const calls = new Map(tools.map(({ name, call }) => [name, call]));
				return { code, tools, calls };
			},
			catch: (cause) => new CodeModeRejected({ message: codeModeError(cause).message }),
		}).pipe(
			Effect.flatMap(({ code, tools, calls }) =>
				Effect.tryPromise({
					try: async () => {
						const bytes = new TextEncoder().encode(JSON.stringify({ code, tools }));
						const hash = await crypto.subtle.digest("SHA-256", bytes);
						return Array.from(new Uint8Array(hash), (byte) =>
							byte.toString(16).padStart(2, "0"),
						).join("");
					},
					catch: codeModeError,
				}).pipe(
					Effect.map((programId) => ({
						programId,
						start(executionId, { startedAt, seed, timeoutMs, onEvent }) {
							const sandbox = new RemoteCodemodeSandbox({ remote: () => remote(executionId) });
							const emit = (event: GuestEvent) => onEvent(event);
							const run = sandbox.start(code, {
								startedAt,
								seed,
								timeoutMs,
								tools: tools.map(({ name }, index) => ({ name, jsName: "tool_" + index })),
								onStarted: (fingerprint) => emit({ type: "started", fingerprint }),
								onCall: ({ id, name, args }) => {
									const call = calls.get(name);
									emit(
										call
											? { type: "call", index: id - 1, call: { ...call, input: args ?? null } }
											: { type: "error", message: "Unknown Code Mode tool " + name + "." },
									);
								},
								onIdle: (sequence, issued) => emit({ type: "idle", sequence, issued }),
							});
							return {
								deliver: ({ index, at, sequence }, reply) =>
									run.deliver(
										sequence,
										at,
										index + 1,
										reply.status === "returned"
											? { ok: true, value: reply.value }
											: { ok: false, message: reply.message, properties: { code: reply.status } },
									),
								wait: Effect.tryPromise({
									try: async () => {
										const result = await run.result;
										if (!result.ok) {
											return {
												type: "error" as const,
												message: result.error.message,
											};
										}
										return {
											type: "done" as const,
											value: output(result),
											sequence: result.during?.seq ?? -1,
											issued: result.during?.issued ?? -1,
										};
									},
									catch: codeModeError,
								}),
								close: () => sandbox.close(),
							};
						},
					})),
				),
			),
		);
}
