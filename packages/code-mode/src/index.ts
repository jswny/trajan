import { RpcTarget } from "cloudflare:workers";
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Random, Schema } from "effect";
import { loadGuest } from "./guest";

export class CodeModeError extends Data.TaggedError("CodeModeError")<{
	readonly message: string;
}> {}

export interface CodeModeTool {
	readonly replay: "safe" | "unsafe";
	readonly isError?: (value: Schema.Json) => boolean;
	readonly run: (
		input: Schema.Json,
		context: {
			readonly callId: string;
			readonly signal: AbortSignal;
			readonly recordDetails: (details: Schema.Json) => void;
		},
	) => Effect.Effect<Schema.Json, CodeModeError>;
}

export interface CodeModeActivity {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "failed" | "interrupted";
	readonly input: Schema.Json;
	readonly reply?: ToolReply;
	readonly details?: Schema.Json;
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
const ToolReply = Schema.Union([
	Schema.Struct({ status: Schema.Literal("returned"), value: boundedJson }),
	Schema.Struct({ status: Schema.Literals(["interrupted", "failed"]), message: Schema.String }),
]);
type ToolReply = typeof ToolReply.Type;
const Entry = Schema.Struct({
	request: Schema.NonEmptyString,
	replay: Schema.Literals(["safe", "unsafe"]),
	reply: Schema.optionalKey(ToolReply),
	details: Schema.optionalKey(boundedJson),
});
type Entry = typeof Entry.Type;
const Run = Schema.Struct({
	source: Schema.String,
	result: Schema.optionalKey(Schema.Struct({ value: boundedJson })),
});
type Run = typeof Run.Type;
const decodeEntry = Schema.decodeUnknownOption(Schema.UndefinedOr(Entry));
const decodeDetails = Schema.decodeUnknownOption(boundedJson);
const decodeRun = Schema.decodeUnknownEffect(Schema.UndefinedOr(Run));

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
	const mutations = new Set<AbortSignal>();

	const run = Effect.fn("code-mode.run")(function* (
		id: string,
		source: string,
		options: RunOptions = {},
	) {
		yield* Schema.decodeEffect(boundedJson)(source).pipe(Effect.mapError(ioError));
		const context = yield* Effect.context<never>();
		const key = `${runPrefix(options.scope ?? id)}${encodeURIComponent(id)}`;
		const entries = `${key}:call:`;
		const saved = yield* decodeRun(storage.kv.get(key)).pipe(
			Effect.mapError(() => new CodeModeError({ message: "Invalid Code Mode run checkpoint." })),
		);
		if (options.recovering && !saved) {
			return yield* new CodeModeError({ message: "The Code Mode checkpoint is missing." });
		}
		if (saved && saved.source !== source) {
			return yield* new CodeModeError({ message: "This run ID belongs to a different script." });
		}
		if (saved?.result) {
			return saved.result.value;
		}
		const scope = yield* Effect.scope;
		yield* Effect.acquireRelease(
			Effect.gen(function* () {
				if (active.has(key)) {
					return yield* new CodeModeError({ message: "This script is already running." });
				}
				if (Array.from(mutations).some((signal) => signal.aborted)) {
					return yield* new CodeModeError({ message: "An interrupted tool is still settling." });
				}
				active.add(key);
			}),
			() => Effect.sync(() => active.delete(key)),
		);
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
					const stored = decodeEntry(storage.kv.get(callId));
					if (Option.isNone(stored)) {
						divergence = `Invalid Code Mode checkpoint for call ${index + 1}.`;
						return failed(divergence);
					}
					const prior = stored.value;
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
					const publish = (
						status: CodeModeActivity["status"],
						reply?: ToolReply,
						details?: Schema.Json,
					) =>
						options.onActivity?.({
							id: callId,
							name,
							status,
							input: input.input,
							...(reply && { reply }),
							...(details !== undefined && { details }),
						}) ?? Effect.void;
					const publishReply = (reply: ToolReply, details?: Schema.Json) =>
						publish(
							reply.status === "returned"
								? tool.isError?.(reply.value)
									? "failed"
									: "completed"
								: reply.status,
							reply,
							details,
						);
					next++;
					if (prior?.reply) {
						yield* publishReply(prior.reply, prior.details);
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
						if (signal.aborted) {
							return yield* Effect.interrupt;
						}
						let details: Schema.Json | undefined;
						const invoke = Effect.suspend(() =>
							tool.run(input.input, {
								callId,
								signal,
								recordDetails: (value) => {
									details = Option.getOrUndefined(decodeDetails(value));
								},
							}),
						);
						// A provider may finish an unsafe action after abort. Keep ownership until it settles.
						const scopedInvoke =
							tool.replay === "safe"
								? invoke
								: Effect.acquireUseRelease(
										Effect.sync(() => mutations.add(signal)),
										() => invoke,
										() => Effect.sync(() => mutations.delete(signal)),
									).pipe(Effect.uninterruptible);
						const reply =
							prior?.replay === "unsafe"
								? interrupted
								: yield* scopedInvoke.pipe(
										Effect.flatMap(Schema.decodeEffect(boundedJson)),
										Effect.match({
											onSuccess: (value): ToolReply => ({ status: "returned", value }),
											onFailure: (error) => failed(errorMessage(error)),
										}),
									);
						if (!open || signal.aborted) {
							return yield* Effect.interrupt;
						}
						const checkpoint = {
							...entry,
							reply,
							...(reply.status === "returned" && details !== undefined && { details }),
						} satisfies Entry;
						storage.kv.put(callId, checkpoint);
						yield* flush;
						yield* publishReply(reply, checkpoint.details);
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
					const host = new HostTools(async (raw) => {
						const exit = await Effect.runPromiseExitWith(context)(
							Effect.forkIn(call(raw), scope).pipe(Effect.flatMap(Fiber.join)),
							{ signal },
						);
						if (Exit.isSuccess(exit)) {
							return exit.value;
						}
						if (signal.aborted) {
							return interrupted;
						}
						throw Cause.squash(exit.cause);
					});
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
		);
	}, Effect.scoped);

	return { run };
}
