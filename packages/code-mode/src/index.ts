import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Random, Schema } from "effect";
import type { Semaphore } from "effect";

export class CodeModeError extends Data.TaggedError("CodeModeError")<{
	readonly message: string;
}> {}

export class CodeModeRejected extends Data.TaggedError("CodeModeRejected")<{
	readonly message: string;
}> {}

type ToolPolicy =
	| { readonly replay: "safe" | "unsafe" }
	// Atomic tools may mutate only storage shared with the execution journal.
	| { readonly replay: "atomic"; readonly mutationLock: Semaphore.Semaphore };

type ToolContext<D = Schema.Json> = {
	readonly callId: string;
	readonly signal: AbortSignal;
	readonly recordDetails: (details: D) => void;
};

export type CodeModeTool = ToolPolicy & {
	readonly parameters?: unknown;
	readonly category?: string;
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
		readonly category?: string;
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
	readonly category?: string;
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
export type CodeModeCatalog = Partial<Record<`codemode:${string}`, ToolNamespace>>;

export function describeTools(catalog: CodeModeCatalog) {
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
export type ToolReply = typeof ToolReply.Type;
const CallCheckpoint = Schema.Struct({
	request: Schema.NonEmptyString,
	replay: Schema.Literals(["safe", "unsafe", "atomic"]),
	reply: Schema.optionalKey(ToolReply),
	details: Schema.optionalKey(boundedJson),
});
export type CallCheckpoint = typeof CallCheckpoint.Type;
const RunCheckpoint = Schema.Struct({
	source: Schema.String,
	result: Schema.optionalKey(Schema.Struct({ value: boundedJson })),
});
export type RunCheckpoint = typeof RunCheckpoint.Type;
export const decodeCallCheckpoint = Schema.decodeUnknownOption(Schema.UndefinedOr(CallCheckpoint));
const decodeDetails = Schema.decodeUnknownOption(boundedJson);
export const decodeRunCheckpoint = Schema.decodeUnknownOption(Schema.UndefinedOr(RunCheckpoint));
const readCall = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCall));

type CallOutcome = {
	readonly reply: ToolReply;
	readonly committed?: CallCheckpoint | undefined;
};

export interface CodeModeJournal {
	/** Stable across restarts and used to correlate tool activity with its receipt. */
	readonly callId: (index: number) => string;
	readonly readRun: () => Option.Option<RunCheckpoint | undefined>;
	readonly readCall: (index: number) => Option.Option<CallCheckpoint | undefined>;
	readonly start: (source: string) => void;
	/** Both intent and outcome records are durable before this effect succeeds. */
	readonly recordCall: (
		index: number,
		checkpoint: CallCheckpoint,
	) => Effect.Effect<void, CodeModeError>;
	readonly finish: (checkpoint: RunCheckpoint) => Effect.Effect<void, CodeModeError>;
	/** Run against the journal's storage. Commit the mutation and receipt together,
	 * or roll back when the callback returns no receipt or execution fails. */
	readonly commitCall: (
		index: number,
		signal: AbortSignal,
		invoke: Effect.Effect<ToolReply>,
		receipt: (reply: ToolReply) => CallCheckpoint | undefined,
	) => Effect.Effect<CallOutcome, CodeModeError>;
}

export interface CodeModeHost {
	readonly openJournal: (scope: string, executionId: string) => CodeModeJournal;
	readonly runGuest: (
		source: string,
		namespaces: ReadonlyMap<string, ReadonlyArray<string>>,
		call: (input: unknown) => Promise<ToolReply>,
	) => Promise<Schema.Json>;
}

const activity = (
	id: string,
	call: ToolCall,
	status: CodeModeActivity["status"],
	category: string | undefined,
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
	...(category && { category }),
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

export function createCodeMode(host: CodeModeHost, catalog: CodeModeCatalog) {
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
		const journal = host.openJournal(scope, id);
		const saved = Option.getOrUndefined(journal.readRun());
		const calls: Array<CodeModeActivity> = [];
		for (let index = 0; index < maxCalls; index++) {
			const callId = journal.callId(index);
			const entry = Option.getOrUndefined(journal.readCall(index));
			if (!entry) {
				break;
			}
			const call = Option.getOrUndefined(readCall(entry.request));
			if (!call) {
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
						tool?.category,
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
		const runScope = options.scope ?? id;
		const key = JSON.stringify([runScope, id]);
		const journal = host.openJournal(runScope, id);
		const checkpoint = journal.readRun();
		if (Option.isNone(checkpoint)) {
			return yield* new CodeModeError({ message: "Invalid Code Mode run checkpoint." });
		}
		const saved = checkpoint.value;
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
				const rejectReplay = (index: number) => {
					divergence = `Code Mode replay diverged at call ${index + 1}.`;
					return failed(divergence);
				};

				const call = Effect.fnUntraced(function* (raw: unknown) {
					if (!open || signal.aborted || inFlight || divergence || next >= maxCalls) {
						return failed(divergence ?? "Code Mode cannot admit this call.");
					}
					const index = next;
					const callId = journal.callId(index);
					const input = yield* Schema.decodeUnknownEffect(ToolCall)(raw).pipe(
						Effect.mapError(ioError),
					);
					const request = JSON.stringify(
						yield* Schema.decodeEffect(boundedJson)(input).pipe(Effect.mapError(ioError)),
					);
					const tool = getTool(input);
					const stored = journal.readCall(index);
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
						Effect.suspend(
							() =>
								options.onActivity?.(
									activity(callId, input, status, tool.category, reply, details),
								) ?? Effect.void,
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

					const entry: CallCheckpoint = prior ?? { request, replay: tool.replay };
					inFlight = true;
					return yield* Effect.gen(function* () {
						if (!prior) {
							// Flush the intent before the tool can change the workspace.
							yield* journal.recordCall(index, entry);
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
						const checkpoint = (reply: ToolReply): CallCheckpoint => ({
							...entry,
							reply,
							...(reply.status === "returned" && details !== undefined && { details }),
						});
						const attempt =
							tool.replay === "atomic"
								? tool.mutationLock.withPermit(
										journal.commitCall(index, signal, invoke, (reply) => {
											// A tool can report a failure after mutating its local storage.
											if (
												!open ||
												signal.aborted ||
												reply.status !== "returned" ||
												tool.isError?.(reply.value)
											) {
												details = undefined;
												return undefined;
											}
											return checkpoint(reply);
										}),
									)
								: invoke.pipe(Effect.map((reply): CallOutcome => ({ reply })));
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
						const receipt = committed ?? checkpoint(reply);
						if (!committed) {
							yield* journal.recordCall(index, receipt);
						}
						yield* publishReply(reply, receipt.details);
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
						journal.start(source);
					}
					const value = await host.runGuest(source, namespaces, async (raw) => {
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
					signal.throwIfAborted();
					if (
						divergence ||
						!Option.exists(journal.readCall(next), (entry) => entry === undefined) ||
						inFlight
					) {
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
			Effect.tap((value) => journal.finish({ source, result: { value } })),
		);
	}, Effect.scoped);

	return { run, readExecution };
}
