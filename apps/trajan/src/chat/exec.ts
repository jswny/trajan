import { tracing } from "cloudflare:workers";
import { describeTools } from "@trajan/code-mode";
import { clearCodeModeRun, createCloudflareCodeMode } from "@trajan/code-mode-cloudflare";
import type { CodeModeSandboxBinding } from "@trajan/code-mode-cloudflare";
import type { CodeModeActivity, CodeModeCatalog } from "@trajan/code-mode";
import { completedToolResult, ToolCall, TurnIoError } from "@trajan/harness";
import type { StepAttempt, ToolResult, TurnMessage, TurnTools } from "@trajan/harness";
import { Console, Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { execName, ExecInput } from "../exec-contract";
import type { ChatToolPreview } from "./protocol";
import {
	describeRecoveredTool,
	RECENT_TOOL_CALLS,
	toolActivity,
	uncertainToolEffects,
} from "./tool-activity";
import type { ToolActivity } from "./tool-presentation";

const Exec = Tool.make(execName, { parameters: ExecInput, success: Schema.Json });

function executionError(cause: unknown) {
	return new TurnIoError({
		operation: Exec.name,
		cause,
		message: cause instanceof Error ? cause.message : String(cause),
	});
}

function unknownOutcome(message: string): Extract<typeof ToolResult.Type, { status: "unknown" }> {
	return {
		status: "unknown",
		message: `${message} The script may have changed state. Inspect it before repeating the action.`,
	};
}

function settledActivity(calls: ReadonlyArray<CodeModeActivity>, limit = calls.length) {
	const uncertainEffects = uncertainToolEffects(calls);
	return {
		...(calls.length > 0 && { activity: calls.slice(-limit).map(toolActivity) }),
		...(uncertainEffects.length > 0 && { uncertainEffects }),
	};
}

function observeExec<A extends typeof ToolResult.Type, E>(
	call: typeof ToolCall.Type,
	{ runId, idempotencyKey: executionId, exhaustedRestartLimit }: StepAttempt,
	work: Effect.Effect<A, E>,
) {
	const fields = { runId, executionId, toolCallId: call.id };
	return Effect.suspend(() => {
		const span = tracing.getActiveSpan();
		span?.setAttributes(fields);
		return work.pipe(
			Effect.tap((result) =>
				Effect.gen(function* () {
					span?.setAttribute("toolStatus", result.status);
					if (exhaustedRestartLimit !== undefined) {
						yield* Console.warn({
							event: "exec:restart-limit",
							...fields,
							toolStatus: result.status,
						});
					}
					for (const { id, name } of result.uncertainEffects ?? []) {
						const details = { ...fields, nestedCallId: id, toolName: name };
						tracing.enterSpan("exec:effect:uncertain", (span) => span.setAttributes(details));
						yield* Console.warn({ event: "exec:effect:uncertain", ...details });
					}
				}),
			),
		);
	});
}

const executionsKey = (runId: string) => `chat-tool-executions:${runId}`;
const failureKey = (runId: string, executionId: string) =>
	`chat-tool-failures:${runId}:${executionId}`;
const decodeFailure = Schema.decodeUnknownSync(
	Schema.UndefinedOr(
		Schema.Struct({
			call: ToolCall,
			status: Schema.Literals(["failed", "unknown"]),
			message: Schema.String,
		}),
	),
);
const decodeExecutions = Schema.decodeUnknownSync(
	Schema.UndefinedOr(
		Schema.Array(
			Schema.Struct({ executionId: Schema.NonEmptyString, callId: Schema.NonEmptyString }),
		),
	),
);

function readExecutions(storage: DurableObjectStorage, runId: string) {
	return decodeExecutions(storage.kv.get(executionsKey(runId))) ?? [];
}

function recordExecution(
	storage: DurableObjectStorage,
	runId: string,
	executionId: string,
	callId: string,
) {
	const executions = readExecutions(storage, runId);
	if (!executions.some((entry) => entry.executionId === executionId)) {
		storage.kv.put(executionsKey(runId), [...executions, { executionId, callId }]);
	}
}

export function createChatExec(
	sandbox: CodeModeSandboxBinding,
	storage: DurableObjectStorage,
	{ catalog, instructions }: { catalog: CodeModeCatalog; instructions: string },
) {
	const codeMode = createCloudflareCodeMode(sandbox, storage, catalog);
	const execute = Effect.fn("chat.exec")(
		function* (...[call, attempt, publishActivity]: Parameters<TurnTools["Service"]["execute"]>) {
			if (call.name !== Exec.name) {
				return { status: "failed" as const, message: `Unknown tool: ${call.name}` };
			}
			const { code } = yield* Schema.decodeUnknownEffect(ExecInput)(call.input);
			const { runId, idempotencyKey: executionId } = attempt;
			yield* Effect.try({
				try: () => recordExecution(storage, runId, executionId, call.id),
				catch: executionError,
			});
			let recent: ReadonlyArray<typeof ToolActivity.Type> = attempt.recovering
				? yield* Effect.try({
						try: () =>
							codeMode
								.readExecution(executionId, runId, "live")
								.calls.slice(-RECENT_TOOL_CALLS)
								.map(toolActivity),
						catch: executionError,
					})
				: [];
			const result = yield* codeMode
				.run(executionId, code, {
					scope: runId,
					recovering: attempt.recovering,
					onActivity: (entry) =>
						Effect.suspend(() => {
							const activity = toolActivity(entry);
							recent = recent.some(({ id }) => id === entry.id)
								? recent.map((item) => (item.id === entry.id ? activity : item))
								: [...recent, activity].slice(-RECENT_TOOL_CALLS);
							return publishActivity(recent);
						}),
				})
				.pipe(
					Effect.match({
						onSuccess: completedToolResult,
						onFailure: (error): typeof ToolResult.Type =>
							error._tag === "CodeModeRejected"
								? { status: "failed", message: error.message }
								: unknownOutcome(error.message),
					}),
				);
			const { calls } = yield* Effect.try({
				try: () => codeMode.readExecution(executionId, runId),
				catch: executionError,
			});
			return { ...result, ...settledActivity(calls) };
		},
		Effect.catchTag("SchemaError", () =>
			Effect.succeed({
				status: "failed" as const,
				message: "Provide non-empty JavaScript source in the code argument.",
			}),
		),
	);
	const recover = Effect.fn("chat.exec.recover")(function* (
		...[, { runId, idempotencyKey }, limit]: Parameters<
			NonNullable<TurnTools["Service"]["recover"]>
		>
	) {
		const { saved, calls } = yield* Effect.try({
			try: () => codeMode.readExecution(idempotencyKey, runId, "settled"),
			catch: executionError,
		});
		const activity = settledActivity(calls);
		if (saved?.result) {
			return { ...completedToolResult(saved.result.value), ...activity };
		}
		const recorded = calls
			.filter(({ reply }) => reply?.status === "returned" || reply?.status === "failed")
			.slice(-RECENT_TOOL_CALLS)
			.map((entry) => describeRecoveredTool(toolActivity(entry)));
		const message = `The script was interrupted ${limit} times and stopped before returning a result.`;
		return {
			...unknownOutcome(
				recorded.length ? `${message} Recorded calls: ${JSON.stringify(recorded)}.` : message,
			),
			...activity,
		};
	});
	const settleExec = Effect.fnUntraced(function* (
		call: typeof ToolCall.Type,
		{ runId, idempotencyKey, recovering }: StepAttempt,
		work: Effect.Effect<typeof ToolResult.Type, TurnIoError>,
	) {
		const key = failureKey(runId, idempotencyKey);
		if (recovering) {
			const saved = yield* Effect.try({
				try: () => decodeFailure(storage.kv.get(key)),
				catch: executionError,
			});
			if (saved) {
				const { calls } = yield* Effect.try({
					try: () => codeMode.readExecution(idempotencyKey, runId, "settled"),
					catch: executionError,
				});
				return { status: saved.status, message: saved.message, ...settledActivity(calls) };
			}
		}
		const result = yield* work;
		if (result.status !== "completed") {
			// Code Mode already stores successful returns and nested receipts.
			// Save the terminal error before handing the outcome back to the turn.
			const { status, message } = result;
			yield* Effect.tryPromise({
				try: (signal) => {
					signal.throwIfAborted();
					storage.transactionSync(() => {
						recordExecution(storage, runId, idempotencyKey, call.id);
						storage.kv.put(key, { call, status, message });
					});
					return storage.sync();
				},
				catch: executionError,
			});
		}
		return result;
	});

	function readRecordedExecutions(runId: string, view: "live" | "settled") {
		return readExecutions(storage, runId).flatMap<{
			call: typeof ToolCall.Type;
			calls: ReadonlyArray<CodeModeActivity>;
			result: typeof ToolResult.Type | undefined;
		}>(({ executionId, callId }) => {
			const failure = decodeFailure(storage.kv.get(failureKey(runId, executionId)));
			const { saved, calls } = codeMode.readExecution(
				executionId,
				runId,
				failure ? "settled" : view,
			);
			if (failure) {
				const { call, status, message } = failure;
				return [{ call, calls, result: { status, message } }];
			}
			if (!saved) {
				return [];
			}
			const call: typeof ToolCall.Type = {
				role: "tool-call",
				id: callId,
				name: Exec.name,
				input: { code: saved.source },
			};
			return [{ call, calls, result: saved.result && completedToolResult(saved.result.value) }];
		});
	}

	function readToolPreviews(runId: string): ReadonlyArray<typeof ChatToolPreview.Type> {
		return readRecordedExecutions(runId, "live").map(({ call, calls, result }) =>
			result
				? {
						call,
						activity: [],
						result: {
							...result,
							...settledActivity(calls, RECENT_TOOL_CALLS),
						},
					}
				: { call, activity: calls.slice(-RECENT_TOOL_CALLS).map(toolActivity) },
		);
	}

	function readSettledTools(runId: string): Array<typeof TurnMessage.Type> {
		return readRecordedExecutions(runId, "settled").flatMap(({ call, calls, result: saved }) => {
			if (!saved && calls.length === 0) {
				return [];
			}
			const result = saved ?? unknownOutcome("The script ended without a completed result.");
			return [
				call,
				{
					role: "tool",
					callId: call.id,
					result: {
						...result,
						...settledActivity(calls),
					},
				},
			];
		});
	}

	return {
		readToolPreviews,
		readSettledTools,
		settleRun(runId: string, outcome: "completed" | "failed" | "cancelled") {
			const messages = outcome === "completed" ? undefined : readSettledTools(runId);
			for (const { executionId } of readExecutions(storage, runId)) {
				storage.kv.delete(failureKey(runId, executionId));
			}
			storage.kv.delete(executionsKey(runId));
			clearCodeModeRun(storage, runId);
			return messages;
		},
		declaration: {
			name: Exec.name,
			description: [
				"Run a JavaScript module. Use export default async function () { ... } and return a JSON result.",
				"console.log and console.error are captured.",
				"Use registered tools for all workspace and external operations. Capabilities cannot be accessed directly by the script.",
				"Import replayable helpers from codemode:runtime for time or randomness that affects tool calls. Await now() for Unix time in milliseconds, random() for a number in [0, 1), or randomUUID() for a version 4 UUID. Each returned value is reused during replay.",
				"Independent tool calls can run concurrently. Await dependent calls in order. If a tool throws with code 'interrupted', inspect its effects before retrying. Base replay-sensitive branches and arguments on stable input and tool results.",
				"Write large results to a workspace file and return the path.",
				instructions,
				...describeTools(catalog),
			].join("\n"),
			parameters: { ...Tool.getJsonSchema(Exec), additionalProperties: false },
		},
		service: {
			execute: (...args: Parameters<typeof execute>) =>
				observeExec(args[0], args[1], settleExec(args[0], args[1], execute(...args))),
			recover: (...args: Parameters<typeof recover>) =>
				observeExec(args[0], args[1], settleExec(args[0], args[1], recover(...args))),
		},
	};
}
