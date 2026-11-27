import {
	Cause,
	Clock,
	Data,
	Effect,
	Fiber,
	Option,
	Queue,
	Random,
	Result,
	Schema,
	Semaphore,
} from "effect";

export class CodeModeError extends Data.TaggedError("CodeModeError")<{
	readonly message: string;
}> {}

export class CodeModeRejected extends Data.TaggedError("CodeModeRejected")<{
	readonly message: string;
}> {}

export interface ToolLock {
	readonly withPermit: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
		input: Schema.Json,
	) => Effect.Effect<A, E, R>;
}

type ToolPolicy =
	| { readonly replay: "safe" }
	| { readonly replay: "unsafe"; readonly reconciliation?: ExternalReconciliation }
	// Atomic tools may mutate only storage shared with the execution journal.
	| {
			readonly replay: "atomic";
			readonly mutationLock: ToolLock;
	  };

type ToolContext<D = Schema.Json> = {
	readonly callId: string;
	readonly signal: AbortSignal;
	readonly recordDetails: (details: D) => void;
	readonly intent?: Schema.Json;
};

interface ExternalReconciliation {
	readonly prepare: (
		input: Schema.Json,
		signal: AbortSignal,
	) => Effect.Effect<Schema.Json, CodeModeError>;
	readonly check: (
		intent: Schema.Json,
		signal: AbortSignal,
	) => Effect.Effect<Option.Option<Schema.Json>, CodeModeError>;
}

export type CodeModeTool = ToolPolicy & {
	/** A local-only operation that needs an isolated read or idempotent write. */
	readonly localStorage?: boolean;
	/** The tool's library touches local storage across external I/O. */
	readonly exclusiveStorage?: boolean;
	readonly lock?: ToolLock;
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

interface ToolDefinition<A, B extends Schema.Json, D extends Schema.Json> {
	readonly input: Schema.Codec<A>;
	readonly output: Schema.Codec<B>;
	readonly details?: Schema.Codec<D>;
	readonly category?: string;
	readonly localStorage?: boolean;
	readonly exclusiveStorage?: boolean;
	readonly lock?: ToolLock;
	readonly description?: string;
	readonly normalizeInput?: (input: Schema.Json) => Schema.Json;
	readonly recovery?: (input: A) => string;
	readonly run: (input: A, context: ToolContext<D>) => Effect.Effect<B, unknown>;
}

export function defineTool<A, B extends Schema.Json, D extends Schema.Json = never>(
	definition: ToolPolicy & ToolDefinition<A, B, D>,
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
				Effect.mapError(codeModeError),
			),
	};
}

export function defineReconciledTool<A, B extends Schema.Json, I, D extends Schema.Json = never>(
	definition: Omit<ToolDefinition<A, B, D>, "run"> & {
		readonly intent: Schema.Codec<I, Schema.Json>;
		/** Capture the evidence needed for recovery before the host allows the external effect. */
		readonly prepare: (input: A, signal: AbortSignal) => Effect.Effect<I, unknown>;
		/** Read the affected system. Return a result only when the saved intent can be confirmed. */
		readonly reconcile: (
			intent: I,
			signal: AbortSignal,
		) => Effect.Effect<Option.Option<B>, unknown>;
		readonly run: (input: A, context: ToolContext<D>, intent: I) => Effect.Effect<B, unknown>;
	},
): CodeModeTool {
	const { intent, prepare, reconcile, run, ...tool } = definition;
	const decodeInput = Schema.decodeUnknownEffect(tool.input);
	const decodeIntent = Schema.decodeUnknownEffect(intent);
	const encodeIntent = Schema.encodeEffect(intent);
	const decodeOutput = Schema.decodeEffect(tool.output);
	return defineTool({
		...tool,
		replay: "unsafe",
		run: (input, context) =>
			decodeIntent(context.intent).pipe(Effect.flatMap((saved) => run(input, context, saved))),
		reconciliation: {
			prepare: (input, signal) =>
				decodeInput(tool.normalizeInput ? tool.normalizeInput(input) : input).pipe(
					Effect.flatMap((value) => prepare(value, signal)),
					Effect.flatMap(encodeIntent),
					Effect.mapError(codeModeError),
				),
			check: (saved, signal) =>
				decodeIntent(saved).pipe(
					Effect.flatMap((value) => reconcile(value, signal)),
					Effect.flatMap((value) =>
						Option.isSome(value) ? Effect.asSome(decodeOutput(value.value)) : Effect.succeedNone,
					),
					Effect.mapError(codeModeError),
				),
		},
	});
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
const maxConcurrentCalls = 8;
const maxValueBytes = 64 * 1024;
const executionBudgetMs = 25_000;
const deadlineExpired = () =>
	new CodeModeError({ message: "The Code Mode execution deadline expired." });
const interrupted: ToolReply = {
	status: "interrupted",
	message:
		"The tool was interrupted and may have applied changes. Inspect its effects before retrying.",
};
const diverged = (message: string) => new CodeModeError({ message });
const failed = (message: string): ToolReply => ({ status: "failed", message });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const codeModeError = (error: unknown) =>
	new CodeModeError({ message: errorMessage(error) });
const decodeRuntimeInput = Schema.decodeUnknownEffect(Schema.Null);

function runtimeTool(sample: Effect.Effect<Schema.Json>): CodeModeTool {
	return {
		replay: "safe",
		run: (input) =>
			decodeRuntimeInput(input).pipe(Effect.mapError(codeModeError), Effect.andThen(sample)),
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
const GuestCall = Schema.Struct({
	index: Schema.Natural.check(Schema.isLessThan(maxCalls)),
	call: ToolCall,
});
const Delivery = Schema.Struct({
	index: GuestCall.fields.index,
	at: Schema.Natural,
});
export type Delivery = typeof Delivery.Type;
const ReplayCheckpoint = Schema.Struct({
	fingerprint: Schema.NonEmptyString,
	deliveries: Schema.Array(Delivery).check(Schema.isMaxLength(maxCalls)),
	issuedAfter: Schema.Array(Schema.Natural.check(Schema.isLessThanOrEqualTo(maxCalls))).check(
		Schema.isMaxLength(maxCalls + 1),
	),
});
type ReplayCheckpoint = typeof ReplayCheckpoint.Type;
export const decodeReplayCheckpoint = Schema.decodeUnknownOption(
	Schema.UndefinedOr(ReplayCheckpoint),
);

export type GuestEvent =
	| { readonly type: "started"; readonly fingerprint: string }
	| { readonly type: "call"; readonly index: number; readonly call: unknown }
	| { readonly type: "idle"; readonly sequence: number; readonly issued: number }
	| {
			readonly type: "done";
			readonly sequence: number;
			readonly issued: number;
			readonly value: unknown;
	  }
	| { readonly type: "error"; readonly message: string };

interface GuestSession {
	readonly deliver: (delivery: Delivery & { readonly sequence: number }, reply: ToolReply) => void;
	readonly wait: Effect.Effect<Extract<GuestEvent, { type: "done" | "error" }>, CodeModeError>;
	readonly close: () => Promise<void>;
}

interface PreparedGuest {
	readonly programId: string;
	readonly start: (
		executionId: string,
		options: {
			readonly startedAt: number;
			readonly seed: number;
			readonly timeoutMs: number;
			readonly onEvent: (event: GuestEvent) => void;
		},
	) => GuestSession;
}
const CallCheckpoint = Schema.Struct({
	request: Schema.NonEmptyString,
	replay: Schema.Literals(["safe", "unsafe", "atomic"]),
	started: Schema.optionalKey(Schema.Boolean),
	intent: Schema.optionalKey(boundedJson),
	reply: Schema.optionalKey(ToolReply),
	details: Schema.optionalKey(boundedJson),
});
export type CallCheckpoint = typeof CallCheckpoint.Type;
const RunCheckpoint = Schema.Struct({
	source: Schema.String,
	vm: Schema.optionalKey(
		Schema.Struct({
			programId: Schema.NonEmptyString,
			startedAt: Schema.Natural,
			seed: Schema.Natural,
		}),
	),
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
	readonly readReplay: () => Option.Option<ReplayCheckpoint | undefined>;
	readonly start: (checkpoint: RunCheckpoint) => Effect.Effect<void, CodeModeError>;
	/** Both intent and outcome records are durable before this effect succeeds. */
	readonly recordCall: (
		index: number,
		checkpoint: CallCheckpoint,
		signal?: AbortSignal,
	) => Effect.Effect<void, CodeModeError>;
	readonly recordReplay: (checkpoint: ReplayCheckpoint) => Effect.Effect<void, CodeModeError>;
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
	readonly isolateStorage?: <A, E>(
		effect: Effect.Effect<A, E>,
	) => Effect.Effect<A, E | CodeModeError>;
	readonly prepareGuest: (
		source: string,
		namespaces: ReadonlyMap<string, ReadonlyArray<string>>,
	) => Effect.Effect<PreparedGuest, CodeModeError | CodeModeRejected>;
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

function validReplay(history: ReplayCheckpoint | undefined, calls: ReadonlyArray<CallCheckpoint>) {
	if (!history) {
		return calls.length === 0;
	}
	const { deliveries, issuedAfter } = history;
	if (
		issuedAfter.length < deliveries.length ||
		issuedAfter.length > deliveries.length + 1 ||
		calls.length > (issuedAfter.at(-1) ?? 0)
	) {
		return false;
	}
	if (issuedAfter.some((issued, seq) => issued < (issuedAfter[seq - 1] ?? 0))) {
		return false;
	}
	const seen = new Set<number>();
	return deliveries.every(({ index, at }, seq) => {
		if (
			!calls[index]?.reply ||
			index >= issuedAfter[seq] ||
			seen.has(index) ||
			at < (deliveries[seq - 1]?.at ?? 0)
		) {
			return false;
		}
		seen.add(index);
		return true;
	});
}

interface Invocation {
	readonly input: ToolCall;
	readonly tool: CodeModeTool;
	readonly entry: CallCheckpoint;
}

export function createCodeMode(host: CodeModeHost, catalog: CodeModeCatalog) {
	const toolsByModule = new Map<string, ToolNamespace>(
		Object.entries({ ...catalog, [runtimeModule]: runtimeTools }),
	);
	const namespaces = new Map(
		Array.from(toolsByModule, ([name, tools]) => [name, Object.keys(tools)]),
	);
	const active = new Set<string>();
	const mutations = new Set<{ readonly signal: AbortSignal; readonly key: string }>();
	const toolSlots = Semaphore.makeUnsafe(maxConcurrentCalls);
	const getTool = ({ module, name }: ToolCall) => {
		const tools = toolsByModule.get(module);
		return tools && Object.hasOwn(tools, name) ? tools[name] : undefined;
	};

	function readExecution(id: string, scope: string, view: "live" | "settled" = "settled") {
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
			const reply =
				entry.reply ??
				(view === "settled" && entry.replay === "unsafe" && entry.started !== false
					? interrupted
					: undefined);
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
		const previous: Array<CallCheckpoint> = [];
		for (let index = 0; index < maxCalls; index++) {
			const entry = journal.readCall(index);
			if (Option.isNone(entry)) {
				return yield* new CodeModeError({
					message: `Invalid Code Mode checkpoint for call ${index + 1}.`,
				});
			}
			if (!entry.value) {
				break;
			}
			previous.push(entry.value);
		}
		if (saved && !saved.vm) {
			return yield* new CodeModeError({
				message: "This unfinished script used a retired Code Mode runtime.",
			});
		}
		const replay = journal.readReplay();
		if (Option.isNone(replay)) {
			return yield* new CodeModeError({ message: "Invalid Code Mode replay checkpoint." });
		}
		const history = replay.value;
		if (!validReplay(history, previous)) {
			return yield* new CodeModeError({ message: "Invalid Code Mode replay checkpoint." });
		}

		yield* Effect.acquireRelease(
			Effect.gen(function* () {
				if (
					active.has(key) ||
					Array.from(mutations).some((owner) => owner.key === key && owner.signal.aborted)
				) {
					return yield* new CodeModeError({ message: "This script is already running." });
				}
				if (Array.from(mutations).some(({ signal }) => signal.aborted)) {
					return yield* new CodeModeError({ message: "An interrupted tool is still settling." });
				}
				active.add(key);
			}),
			() => Effect.sync(() => active.delete(key)),
		);
		const guest = yield* host
			.prepareGuest(source, namespaces)
			.pipe(Effect.mapError((error) => (saved ? codeModeError(error) : error)));
		if (saved?.vm && saved.vm.programId !== guest.programId) {
			return yield* new CodeModeError({
				message: "The Code Mode program changed during recovery.",
			});
		}
		const vm = saved?.vm ?? {
			programId: guest.programId,
			startedAt: yield* Clock.currentTimeMillis,
			seed: (yield* Random.nextIntBetween(0, 0x1_00_00_00_00)) >>> 0,
		};
		if (!saved) {
			yield* journal.start({ source, vm });
		}
		// The journaled start time makes every attempt share the same execution budget.
		const remaining = vm.startedAt + executionBudgetMs - (yield* Clock.currentTimeMillis);
		if (remaining <= 0) {
			return yield* deadlineExpired();
		}
		return yield* runGuest(
			guest,
			journal,
			key,
			{ vm, timeoutMs: remaining },
			history,
			previous,
			options,
		).pipe(
			Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.fail(deadlineExpired()) }),
			Effect.flatMap(Schema.decodeUnknownEffect(boundedJson)),
			Effect.mapError(codeModeError),
			Effect.tap((value) => journal.finish({ source, vm, result: { value } })),
		);
	}, Effect.scoped);

	const executeCall = Effect.fnUntraced(function* (
		index: number,
		invocation: Invocation,
		prior: CallCheckpoint | undefined,
		{
			journal,
			key,
			signal,
			onActivity,
		}: {
			readonly journal: CodeModeJournal;
			readonly key: string;
			readonly signal: AbortSignal;
			readonly onActivity: RunOptions["onActivity"];
		},
	) {
		const { input, tool, entry } = invocation;
		const callId = journal.callId(index);
		const publish = (
			status: CodeModeActivity["status"],
			reply?: ToolReply,
			details?: Schema.Json,
		) =>
			Effect.suspend(
				() =>
					onActivity?.(activity(callId, input, status, tool.category, reply, details)) ??
					Effect.void,
			).pipe(
				Effect.catchCauseIf(
					(cause) => !Cause.hasInterruptsOnly(cause),
					(cause) => Effect.logWarning("Code Mode activity publication failed", cause),
				),
			);
		const publishReply = (reply: ToolReply, details?: Schema.Json) =>
			publish(replyStatus(tool, reply), reply, details);
		if (prior?.reply) {
			yield* publishReply(prior.reply, prior.details);
			return prior.reply;
		}

		const receipt = yield* toolSlots.withPermits(tool.exclusiveStorage ? maxConcurrentCalls : 1)(
			Effect.gen(function* () {
				const uncertain = prior?.replay === "unsafe" && prior.started !== false;
				if (!uncertain) {
					yield* publish("running");
				}
				if (signal.aborted) {
					return yield* Effect.interrupt;
				}
				let details: Schema.Json | undefined;
				let started = entry;
				const invoke = Effect.suspend(() =>
					tool.run(input.input, {
						callId,
						signal,
						...(started.intent !== undefined && { intent: started.intent }),
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
					...started,
					reply,
					...(reply.status === "returned" && details !== undefined && { details }),
				});
				const attempt =
					tool.replay === "atomic"
						? tool.mutationLock.withPermit(
								journal.commitCall(index, signal, invoke, (reply) => {
									// A tool can report a failure after mutating its local storage.
									if (
										signal.aborted ||
										reply.status !== "returned" ||
										tool.isError?.(reply.value)
									) {
										details = undefined;
										return undefined;
									}
									return checkpoint(reply);
								}),
								input.input,
							)
						: (tool.localStorage && host.isolateStorage
								? Effect.uninterruptible(host.isolateStorage(invoke))
								: invoke
							).pipe(Effect.map((reply): CallOutcome => ({ reply })));
				// A mutation can finish after abort. Keep ownership until it settles.
				const invokeWhenOpen = Effect.suspend(() => (!signal.aborted ? attempt : Effect.interrupt));
				const execute =
					tool.replay === "unsafe"
						? Effect.gen(function* () {
								const prepared = yield* Effect.result(
									tool.reconciliation
										? tool.reconciliation
												.prepare(input.input, signal)
												.pipe(Effect.flatMap(Schema.decodeEffect(boundedJson)))
										: Effect.undefined,
								);
								if (Result.isFailure(prepared)) {
									return { reply: failed(errorMessage(prepared.failure)) };
								}
								started = {
									...entry,
									started: true,
									...(prepared.success !== undefined && { intent: prepared.success }),
								};
								yield* journal.recordCall(index, started, signal);
								return yield* invokeWhenOpen;
							})
						: invokeWhenOpen;
				const reconcile = Effect.gen(function* (): Effect.fn.Return<CallOutcome> {
					const saved = prior?.intent;
					if (saved === undefined || tool.replay !== "unsafe" || !tool.reconciliation) {
						return { reply: interrupted };
					}
					const result = yield* tool.reconciliation.check(saved, signal).pipe(
						Effect.flatMap((value) =>
							Option.isSome(value)
								? Effect.asSome(Schema.decodeEffect(boundedJson)(value.value))
								: Effect.succeedNone,
						),
						Effect.orElseSucceed(() => Option.none()),
					);
					return {
						reply: Option.isSome(result)
							? { status: "returned", value: result.value }
							: interrupted,
					};
				});
				const operation = uncertain ? reconcile : execute;
				const locked = tool.lock ? tool.lock.withPermit(operation, input.input) : operation;
				const settle = Effect.gen(function* () {
					const { reply, committed } = yield* locked;
					if (signal.aborted) {
						return yield* Effect.interrupt;
					}
					const receipt = committed ?? checkpoint(reply);
					if (!committed) {
						yield* journal.recordCall(index, receipt, signal);
					}
					return { reply, receipt };
				});
				const { reply, receipt } = yield* tool.replay === "safe" || uncertain
					? settle
					: Effect.acquireUseRelease(
							Effect.sync(() => {
								const owner = { signal, key };
								mutations.add(owner);
								return owner;
							}),
							() => settle,
							(owner) => Effect.sync(() => mutations.delete(owner)),
						).pipe(Effect.uninterruptible);
				yield* publishReply(reply, receipt.details);
				return receipt;
			}),
		);
		return receipt.reply ?? interrupted;
	});

	function runGuest(
		guest: PreparedGuest,
		journal: CodeModeJournal,
		key: string,
		{ vm, timeoutMs }: { vm: NonNullable<RunCheckpoint["vm"]>; timeoutMs: number },
		history: ReplayCheckpoint | undefined,
		previous: ReadonlyArray<CallCheckpoint>,
		options: RunOptions,
	) {
		return Effect.gen(function* () {
			type SchedulerEvent =
				| GuestEvent
				| { readonly type: "settled"; readonly index: number; readonly reply: ToolReply };
			const queue = yield* Queue.unbounded<SchedulerEvent>();
			const emit = (event: SchedulerEvent) => {
				Queue.offerUnsafe(queue, event);
			};
			const session = yield* Effect.acquireRelease(
				Effect.try({
					try: () => guest.start(key, { ...vm, timeoutMs, onEvent: emit }),
					catch: codeModeError,
				}),
				(session) =>
					Effect.tryPromise({ try: () => session.close(), catch: codeModeError }).pipe(
						Effect.catch((error) => Effect.logWarning("Code Mode sandbox close failed", error)),
					),
			);
			const tasks = new Set<Fiber.Fiber<void>>();
			// Uninterruptible mutations retain ownership until they have actually settled.
			yield* Effect.addFinalizer(() => Effect.forkDetach(Fiber.interruptAll(tasks)));
			const signal = yield* Effect.abortSignal;
			yield* session.wait.pipe(
				Effect.match({
					onFailure: (error) => ({ type: "error", message: error.message }) as const,
					onSuccess: (event) => event,
				}),
				Effect.map(emit),
				Effect.forkScoped,
			);
			const requests: Array<Invocation> = [];
			const invoke = (index: number) =>
				executeCall(index, requests[index], previous[index], {
					journal,
					key,
					signal,
					onActivity: options.onActivity,
				});
			const deliveries = [...(history?.deliveries ?? [])];
			const issuedAfter = [...(history?.issuedAfter ?? [])];
			const ready = new Map<number, ToolReply>();
			let fingerprint: string | undefined;
			let sequence = 0;
			let initiated = 0;
			let idle = false;
			const persist = (verified: string) =>
				journal.recordReplay({
					fingerprint: verified,
					deliveries: deliveries.slice(),
					issuedAfter: issuedAfter.slice(),
				});

			const acknowledge = Effect.fnUntraced(function* (received: number, issued: number) {
				if (
					!fingerprint ||
					received !== sequence ||
					issued !== requests.length ||
					(issuedAfter[sequence] !== undefined && issuedAfter[sequence] !== issued)
				) {
					return yield* diverged("Code Mode replay diverged at a sandbox checkpoint.");
				}
				if (issuedAfter[sequence] === undefined) {
					issuedAfter.push(issued);
					yield* persist(fingerprint);
				}
			});

			const send = Effect.fnUntraced(function* (delivery: Delivery, reply: ToolReply) {
				idle = false;
				sequence++;
				yield* Effect.try({
					try: () => session.deliver({ ...delivery, sequence }, reply),
					catch: codeModeError,
				});
			});

			while (true) {
				const event = yield* Queue.take(queue);
				switch (event.type) {
					case "started":
						if (fingerprint || (history && history.fingerprint !== event.fingerprint)) {
							return yield* diverged("The Code Mode sandbox runtime changed during recovery.");
						}
						fingerprint = event.fingerprint;
						if (!history) {
							yield* persist(fingerprint);
						}
						break;
					case "call": {
						const { index, call: input } = yield* Schema.decodeUnknownEffect(GuestCall)(event).pipe(
							Effect.mapError(codeModeError),
						);
						if (
							!fingerprint ||
							idle ||
							index !== requests.length ||
							(issuedAfter[sequence] !== undefined && index >= issuedAfter[sequence])
						) {
							return yield* diverged("Code Mode replay diverged at a sandbox call.");
						}
						const tool = getTool(input);
						const request = JSON.stringify(
							yield* Schema.decodeEffect(boundedJson)(input).pipe(Effect.mapError(codeModeError)),
						);
						const prior = previous[index];
						if (prior && (prior.request !== request || prior.replay !== tool?.replay)) {
							return yield* diverged(`Code Mode replay diverged at call ${index + 1}.`);
						}
						if (!tool) {
							return yield* diverged("Unknown Code Mode tool.");
						}
						requests.push({
							input,
							tool,
							entry: prior ?? {
								request,
								replay: tool.replay,
								...(tool.replay === "unsafe" && { started: false }),
							},
						});
						break;
					}
					case "idle": {
						if (idle) {
							return yield* diverged("Duplicate Code Mode sandbox checkpoint.");
						}
						yield* acknowledge(event.sequence, event.issued);
						const recorded = deliveries[sequence];
						if (recorded) {
							const reply = previous[recorded.index]?.reply;
							if (!reply || recorded.index >= requests.length) {
								return yield* diverged("Code Mode replay diverged before a recorded delivery.");
							}
							// Restore the activity stream from the same receipt the VM will receive.
							yield* invoke(recorded.index);
							yield* send(recorded, reply);
							break;
						}
						if (requests.length < previous.length) {
							return yield* diverged("Code Mode replay ended before reaching its saved calls.");
						}
						for (
							let index = Math.max(initiated, previous.length);
							index < requests.length;
							index++
						) {
							yield* journal.recordCall(index, requests[index].entry);
						}
						// Historical deliveries have already settled and must never be invoked again.
						const delivered = new Set(deliveries.map(({ index }) => index));
						for (let index = initiated; index < requests.length; index++) {
							if (delivered.has(index)) {
								continue;
							}
							const fiber = yield* invoke(index).pipe(
								Effect.matchCause({
									onSuccess: (reply) => ({ type: "settled", index, reply }) as const,
									onFailure: (cause) =>
										({ type: "error", message: errorMessage(Cause.squash(cause)) }) as const,
								}),
								Effect.map(emit),
								Effect.forkDetach,
							);
							tasks.add(fiber);
						}
						initiated = requests.length;
						idle = true;
						break;
					}
					case "settled":
						ready.set(event.index, event.reply);
						break;
					case "done":
						yield* acknowledge(event.sequence, event.issued);
						if (
							sequence !== deliveries.length ||
							sequence !== requests.length ||
							requests.length < previous.length
						) {
							return yield* diverged("Code Mode ended before reaching its recovery checkpoint.");
						}
						return event.value;
					case "error":
						return yield* new CodeModeError({ message: event.message });
				}
				if (idle && fingerprint && ready.size) {
					const next = ready.entries().next();
					if (next.done) {
						continue;
					}
					const [index, reply] = next.value;
					ready.delete(index);
					const at = Math.max(
						yield* Clock.currentTimeMillis,
						deliveries.at(-1)?.at ?? vm.startedAt,
					);
					const delivery = { index, at };
					deliveries.push(delivery);
					// Persist the scheduler decision before the VM receives it or runs more code.
					yield* persist(fingerprint);
					yield* send(delivery, reply);
				}
			}
		}).pipe(Effect.scoped);
	}

	return { run, readExecution };
}
