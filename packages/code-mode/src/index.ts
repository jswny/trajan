import { RpcTarget } from "cloudflare:workers";
import { Clock, Data, Effect, Random, Schema } from "effect";
import { loadGuest } from "./guest";
import type { ToolReply } from "./guest";

export class CodeModeError extends Data.TaggedError("CodeModeError")<{
	readonly message: string;
}> {}

export interface CodeModeTool {
	readonly replay: "safe" | "unsafe";
	readonly isError?: (value: Schema.Json) => boolean;
	readonly run: (
		input: Schema.Json,
		context: { readonly callId: string; readonly signal: AbortSignal },
	) => Effect.Effect<Schema.Json, CodeModeError>;
}

export interface CodeModeActivity {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "failed" | "interrupted";
}

interface RunOptions {
	readonly scope?: string;
	readonly recovering?: boolean;
	readonly onActivity?: (activity: CodeModeActivity) => Effect.Effect<void, CodeModeError>;
}

const applicationModules = ["codemode:tools", "codemode:git"] as const;
const runtimeModule = "codemode:runtime";
const ToolCall = Schema.Struct({
	module: Schema.Literals([...applicationModules, runtimeModule]),
	name: Schema.String,
	input: Schema.Json,
});

type ToolCall = typeof ToolCall.Type;
type Entry = {
	readonly request: string;
	readonly replay: CodeModeTool["replay"];
	readonly reply?: ToolReply;
};
type Run = { readonly source: string; readonly result?: { readonly value: Schema.Json } };
type ToolNamespace = Readonly<Record<string, CodeModeTool>>;
type Catalog = Partial<Record<(typeof applicationModules)[number], ToolNamespace>>;

const maxCalls = 64;
const maxValueBytes = 64 * 1024;
const interrupted: ToolReply = {
	status: "interrupted",
	message:
		"The tool was interrupted and may have applied changes. Inspect its effects before retrying.",
};
const failed = (message: string): ToolReply => ({ status: "failed", message });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ioError = (error: unknown) => new CodeModeError({ message: errorMessage(error) });
const decodeRuntimeInput = Schema.decodeUnknownEffect(Schema.Null);

function runtimeTool(sample: Effect.Effect<Schema.Json>): CodeModeTool {
	return {
		replay: "safe",
		run: (input) =>
			decodeRuntimeInput(input).pipe(Effect.mapError(ioError), Effect.andThen(sample)),
	};
}

const runtimeTools = {
	now: runtimeTool(Clock.currentTimeMillis),
	random: runtimeTool(Random.next),
	randomUUID: runtimeTool(Effect.sync(() => crypto.randomUUID())),
} satisfies ToolNamespace;

const boundedJson = Schema.Json.check(
	Schema.makeFilter(
		(value: Schema.Json) =>
			new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxValueBytes ||
			"Code Mode values must fit within 64 KiB.",
	),
);

function runPrefix(scope: string) {
	return `code-mode:${encodeURIComponent(scope)}:`;
}

export function clearCodeModeRun(storage: DurableObjectStorage, scope: string) {
	for (const [key] of Array.from(storage.kv.list({ prefix: runPrefix(scope) }))) {
		storage.kv.delete(key);
	}
}

class HostTools extends RpcTarget {
	readonly #call: (call: unknown) => Promise<ToolReply>;

	constructor(call: (call: unknown) => Promise<ToolReply>) {
		super();
		this.#call = call;
	}

	call(call: unknown) {
		return this.#call(call);
	}
}

export function createCodeMode(
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	catalog: Catalog,
) {
	const toolsByModule = new Map<string, ToolNamespace>(
		Object.entries({ ...catalog, [runtimeModule]: runtimeTools }),
	);
	const namespaces = new Map(
		Array.from(toolsByModule, ([name, tools]) => [name, Object.keys(tools)]),
	);
	const active = new Set<string>();

	const run = Effect.fn("code-mode.run")(function* (
		id: string,
		source: string,
		options: RunOptions = {},
	) {
		yield* Schema.decodeEffect(boundedJson)(source).pipe(Effect.mapError(ioError));
		const context = yield* Effect.context<never>();
		const key = `${runPrefix(options.scope ?? id)}${encodeURIComponent(id)}`;
		const entries = `${key}:call:`;
		const saved = storage.kv.get<Run>(key);
		if (options.recovering && !saved) {
			return yield* new CodeModeError({ message: "The Code Mode checkpoint is missing." });
		}
		if (saved && saved.source !== source) {
			return yield* new CodeModeError({ message: "This run ID belongs to a different script." });
		}
		if (saved?.result) {
			return saved.result.value;
		}
		if (active.has(key)) {
			return yield* new CodeModeError({ message: "This script is already running." });
		}

		active.add(key);
		return yield* Effect.tryPromise({
			try: async (signal) => {
				let open = true;
				let inFlight = false;
				let next = 0;
				let divergence: string | undefined;
				const flush = Effect.tryPromise({ try: () => storage.sync(), catch: ioError });
				const rejectReplay = (index: number) => {
					divergence = `Code Mode replay diverged at call ${index + 1}.`;
					return failed(divergence);
				};

				const call = Effect.fnUntraced(function* (raw: unknown) {
					if (!open || signal.aborted || inFlight || divergence || next >= maxCalls) {
						return failed(divergence ?? "Code Mode cannot admit this call.");
					}
					const index = next;
					const callId = `${entries}${index}`;
					const input = yield* Schema.decodeUnknownEffect(ToolCall)(raw).pipe(
						Effect.mapError(ioError),
					);
					const request = JSON.stringify(
						yield* Schema.decodeEffect(boundedJson)(input).pipe(Effect.mapError(ioError)),
					);
					const tools = toolsByModule.get(input.module);
					const tool = tools && Object.hasOwn(tools, input.name) ? tools[input.name] : undefined;
					const prior = storage.kv.get<Entry>(callId);
					if (prior && (prior.request !== request || prior.replay !== tool?.replay)) {
						return rejectReplay(index);
					}
					if (!tool) {
						return failed("Unknown Code Mode tool.");
					}
					const name =
						input.module === "codemode:tools"
							? input.name
							: `${input.module.slice("codemode:".length)}.${input.name}`;
					const publish = (status: CodeModeActivity["status"]) =>
						options.onActivity?.({ id: callId, name, status }) ?? Effect.void;
					const publishReply = (reply: ToolReply) =>
						publish(
							reply.status === "returned"
								? tool.isError?.(reply.value)
									? "failed"
									: "completed"
								: reply.status,
						);
					next++;
					if (prior?.reply) {
						yield* publishReply(prior.reply);
						return prior.reply;
					}

					const entry: Entry = prior ?? { request, replay: tool.replay };
					inFlight = true;
					return yield* Effect.gen(function* () {
						if (!prior) {
							// Flush the intent before the tool can change the workspace.
							storage.kv.put(callId, entry);
							yield* flush;
						}
						if (prior?.replay !== "unsafe") {
							yield* publish("running");
						}
						const reply =
							prior?.replay === "unsafe"
								? interrupted
								: yield* tool.run(input.input, { callId, signal }).pipe(
										Effect.flatMap(Schema.decodeEffect(boundedJson)),
										Effect.match({
											onSuccess: (value): ToolReply => ({ status: "returned", value }),
											onFailure: (error) => failed(errorMessage(error)),
										}),
									);
						if (!open || signal.aborted) {
							return yield* Effect.interrupt;
						}
						storage.kv.put(callId, { ...entry, reply } satisfies Entry);
						yield* flush;
						yield* publishReply(reply);
						return reply;
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								inFlight = false;
							}),
						),
					);
				});

				try {
					if (!saved) {
						storage.kv.put(key, { source } satisfies Run);
					}
					const guest = loadGuest<HostTools>(loader, source, namespaces);
					const host = new HostTools((raw) =>
						Effect.runPromiseWith(context)(call(raw), { signal }),
					);
					const value = await guest.run(host);
					signal.throwIfAborted();
					if (divergence || storage.kv.get(`${entries}${next}`) !== undefined || inFlight) {
						throw new CodeModeError({
							message: divergence ?? "Code Mode ended before reaching its recovery checkpoint.",
						});
					}
					return value;
				} finally {
					open = false;
				}
			},
			catch: ioError,
		}).pipe(
			Effect.timeout("30 seconds"),
			Effect.flatMap(Schema.decodeEffect(boundedJson)),
			Effect.mapError(ioError),
			Effect.tap((value) =>
				Effect.tryPromise({
					try: async () => {
						storage.kv.put(key, { source, result: { value } } satisfies Run);
						await storage.sync();
					},
					catch: ioError,
				}),
			),
			Effect.ensuring(Effect.sync(() => active.delete(key))),
		);
	});

	return { run };
}
