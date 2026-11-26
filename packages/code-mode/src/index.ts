import { RpcTarget } from "cloudflare:workers";
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Random, Schema } from "effect";
import type { Semaphore } from "effect";
import { loadGuest } from "./guest";

export class CodeModeError extends Data.TaggedError("CodeModeError")<{
	readonly message: string;
}> {}

export class CodeModeRejected extends Data.TaggedError("CodeModeRejected")<{
	readonly message: string;
}> {}

type ToolPolicy =
	| { readonly replay: "safe" | "unsafe" }
	// Atomic tools may mutate only this Durable Object's storage.
	| { readonly replay: "atomic"; readonly mutationLock: Semaphore.Semaphore };

type ToolContext<D = Schema.Json> = {
	readonly callId: string;
	readonly signal: AbortSignal;
	readonly recordDetails: (details: D) => void;
};

export type CodeModeTool = ToolPolicy & {
	readonly parameters?: unknown;
	readonly description?: string;
	readonly describeUncertainty?: (input: Schema.Json) => string | undefined;
	readonly isError?: (value: Schema.Json) => boolean;
	readonly run: (
		input: Schema.Json,
		context: ToolContext,
	) => Effect.Effect<Schema.Json, CodeModeError>;
};

export function defineTool<A, B extends Schema.Json, D extends Schema.Json = never>(
	definition: ToolPolicy & {
		readonly input: Schema.Codec<A>;
		readonly output: Schema.Codec<B>;
		readonly details?: Schema.Codec<D>;
		readonly description?: string;
		readonly normalizeInput?: (input: Schema.Json) => Schema.Json;
		readonly recovery?: (input: A) => string;
		readonly run: (input: A, context: ToolContext<D>) => Effect.Effect<B, unknown>;
	},
): CodeModeTool {
	const { input, output, details, description, normalizeInput, recovery, run, ...policy } =
		definition;
	const decodeInput = Schema.decodeUnknownEffect(input);
	const decodeDetails = details && Schema.decodeUnknownEffect(details);
	return {
		...policy,
		parameters: Schema.toJsonSchemaDocument(input).schema,
		...(description && { description }),
		...(recovery && {
			describeUncertainty: (raw) =>
				Option.map(
					Schema.decodeUnknownOption(input)(normalizeInput ? normalizeInput(raw) : raw),
					recovery,
				).pipe(Option.getOrUndefined),
		}),
		run: (raw, context) =>
			decodeInput(normalizeInput ? normalizeInput(raw) : raw).pipe(
				Effect.flatMap((args) =>
					Effect.suspend(() => {
						let recorded: D | undefined;
						return run(args, {
							...context,
							recordDetails: (value) => {
								recorded = value;
							},
						}).pipe(
							Effect.tap(() =>
								decodeDetails && recorded !== undefined
									? decodeDetails(recorded).pipe(Effect.map(context.recordDetails))
									: Effect.void,
							),
						);
					}),
				),
				Effect.flatMap(Schema.decodeEffect(output)),
				Effect.mapError(ioError),
			),
	};
}

export interface CodeModeActivity {
	readonly id: string;
	readonly name: string;
	readonly status: "running" | "completed" | "failed" | "interrupted";
	readonly input: Schema.Json;
	readonly reply?: ToolReply;
	readonly details?: Schema.Json;
	readonly uncertainty?: string;
}

interface RunOptions {
	readonly scope?: string;
	readonly recovering?: boolean;
	readonly onActivity?: (activity: CodeModeActivity) => Effect.Effect<void, CodeModeError>;
}

const runtimeModule = "codemode:runtime";
const ToolCall = Schema.Struct({
	module: Schema.NonEmptyString,
	name: Schema.String,
	input: Schema.Json,
});

type ToolCall = typeof ToolCall.Type;
type ToolNamespace = Readonly<Record<string, CodeModeTool>>;
type Catalog = Partial<Record<`codemode:${string}`, ToolNamespace>>;

export function describeTools(catalog: Catalog) {
	return Object.entries(catalog).flatMap(([module, tools]) =>
		Object.entries(tools ?? {}).flatMap(([name, { parameters, description }]) =>
			parameters === undefined
				? []
				: [
						`${module} / ${name}${description ? `: ${description}` : ""}\nArguments: ${JSON.stringify(parameters)}`,
					],
		),
	);
}

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
	replay: Schema.Literals(["safe", "unsafe", "atomic"]),
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
const readRun = Schema.decodeUnknownOption(Run);
const readCall = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCall));

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

const activity = (
	id: string,
	call: ToolCall,
	status: CodeModeActivity["status"],
	reply?: ToolReply,
	details?: Schema.Json,
	uncertainty?: string,
): CodeModeActivity => ({
	id,
	name:
		call.module === "codemode:tools"
			? call.name
			: `${call.module.slice("codemode:".length)}.${call.name}`,
	status,
	input: call.input,
	...(reply && { reply }),
	...(details !== undefined && { details }),
	...(uncertainty && { uncertainty }),
});
const replyStatus = (tool: CodeModeTool | undefined, reply: ToolReply) =>
	reply.status === "returned"
		? tool?.isError?.(reply.value)
			? "failed"
			: "completed"
		: reply.status;

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
	const getTool = ({ module, name }: ToolCall) => {
		const tools = toolsByModule.get(module);
		return tools && Object.hasOwn(tools, name) ? tools[name] : undefined;
	};

	function readExecution(id: string, scope: string) {
		const key = `${runPrefix(scope)}${encodeURIComponent(id)}`;
		const saved = Option.getOrUndefined(readRun(storage.kv.get(key)));
		const calls: Array<CodeModeActivity> = [];
		for (let index = 0; index < maxCalls; index++) {
			const callId = `${key}:call:${index}`;
			const entry = Option.getOrUndefined(decodeEntry(storage.kv.get(callId)));
			if (!entry) {
				break;
			}
			const call = Option.getOrUndefined(readCall(entry.request));
			if (!call || call.module === runtimeModule) {
				continue;
			}
			const reply = entry.reply ?? (entry.replay === "unsafe" ? interrupted : undefined);
			if (reply) {
				const tool = getTool(call);
				calls.push(
					activity(
						callId,
						call,
						replyStatus(tool, reply),
						reply,
						entry.details,
						reply.status === "interrupted" ? tool?.describeUncertainty?.(call.input) : undefined,
					),
				);
			}
		}
		return { saved, calls };
	}

	const run = Effect.fn("code-mode.run")(function* (
		id: string,
		source: string,
		options: RunOptions = {},
	) {
		yield* Schema.decodeEffect(boundedJson)(source).pipe(
			Effect.mapError((error) => new CodeModeRejected({ message: error.message })),
		);
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
					const tool = getTool(input);
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
					const publish = (
						status: CodeModeActivity["status"],
						reply?: ToolReply,
						details?: Schema.Json,
					) =>
						Effect.suspend(() =>
							input.module === runtimeModule
								? Effect.void
								: (options.onActivity?.(activity(callId, input, status, reply, details)) ??
									Effect.void),
						).pipe(
							Effect.catchCauseIf(
								(cause) => !Cause.hasInterruptsOnly(cause),
								(cause) => Effect.logWarning("Code Mode activity publication failed", cause),
							),
						);
					const publishReply = (reply: ToolReply, details?: Schema.Json) =>
						publish(replyStatus(tool, reply), reply, details);
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
						).pipe(
							Effect.flatMap(Schema.decodeEffect(boundedJson)),
							Effect.match({
								onSuccess: (value): ToolReply => ({ status: "returned", value }),
								onFailure: (error) => failed(errorMessage(error)),
							}),
						);
						const save = (reply: ToolReply): Entry => {
							const checkpoint = {
								...entry,
								reply,
								...(reply.status === "returned" && details !== undefined && { details }),
							};
							storage.kv.put(callId, checkpoint);
							return checkpoint;
						};
						// Take the workspace lock before entering the storage transaction.
						const attempt =
							tool.replay === "atomic"
								? tool.mutationLock.withPermit(
										Effect.tryPromise({
											try: () =>
												storage.transaction(async (txn) => {
													signal.throwIfAborted();
													const reply = await Effect.runPromiseWith(context)(invoke);
													// A failure can be returned after a partial mutation.
													if (
														!open ||
														signal.aborted ||
														reply.status !== "returned" ||
														tool.isError?.(reply.value)
													) {
														txn.rollback();
														details = undefined;
														return { reply, committed: undefined };
													}
													return { reply, committed: save(reply) };
												}),
											catch: ioError,
										}),
									)
								: invoke.pipe(Effect.map((reply) => ({ reply, committed: undefined })));
						// A mutation can finish after abort. Keep ownership until it settles.
						const scopedInvoke =
							tool.replay === "safe"
								? attempt
								: Effect.acquireUseRelease(
										Effect.sync(() => mutations.add(signal)),
										() => attempt,
										() => Effect.sync(() => mutations.delete(signal)),
									).pipe(Effect.uninterruptible);
						const { reply, committed } =
							prior?.replay === "unsafe"
								? { reply: interrupted, committed: undefined }
								: yield* scopedInvoke;
						if (!open || signal.aborted) {
							return yield* Effect.interrupt;
						}
						const checkpoint = committed ?? save(reply);
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

	return { run, readExecution };
}
