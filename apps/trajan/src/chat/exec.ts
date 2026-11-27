import { describeTools } from "@trajan/code-mode";
import { clearCodeModeRun, createCloudflareCodeMode } from "@trajan/code-mode-cloudflare";
import type { CodeModeActivity, CodeModeCatalog, CodeModeTool } from "@trajan/code-mode";
import { completedToolResult, TurnIoError } from "@trajan/harness";
import type { ToolResult, TurnMessage, TurnTools } from "@trajan/harness";
import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { execName, ExecInput } from "../exec-contract";
import { scheduleInstructions } from "../turn-schedules";
import { RECENT_TOOL_CALLS, toolActivity, uncertainToolEffects } from "./tool-activity";
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

function settledActivity(calls: ReadonlyArray<CodeModeActivity>) {
	const uncertainEffects = uncertainToolEffects(calls);
	return {
		...(calls.length > 0 && { activity: calls.map(toolActivity) }),
		...(uncertainEffects.length > 0 && { uncertainEffects }),
	};
}

const executionsKey = (runId: string) => `chat-tool-executions:${runId}`;
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
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	scheduleTools: Readonly<Record<string, CodeModeTool>>,
	{ catalog, instructions }: { catalog: CodeModeCatalog; instructions: string },
) {
	const registry = {
		...catalog,
		"codemode:tools": { ...catalog["codemode:tools"], ...scheduleTools },
	};
	const codeMode = createCloudflareCodeMode(loader, storage, registry);
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
			let recent: ReadonlyArray<typeof ToolActivity.Type> = [];
			const result = yield* codeMode
				.run(executionId, code, {
					scope: runId,
					recovering: attempt.recovering,
					onActivity: (entry) =>
						Effect.suspend(() => {
							recent = [...recent.filter(({ id }) => id !== entry.id), toolActivity(entry)].slice(
								-RECENT_TOOL_CALLS,
							);
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

	function readSettledTools(runId: string): Array<typeof TurnMessage.Type> {
		return readExecutions(storage, runId).flatMap(({ executionId, callId }) => {
			const { saved, calls } = codeMode.readExecution(executionId, runId);
			if (!saved || (!saved.result && calls.length === 0)) {
				return [];
			}
			const result = saved.result
				? completedToolResult(saved.result.value)
				: unknownOutcome("The script ended without a completed result.");
			return [
				{ role: "tool-call", id: callId, name: Exec.name, input: { code: saved.source } },
				{
					role: "tool",
					callId,
					result: {
						...result,
						...settledActivity(calls),
					},
				},
			];
		});
	}

	return {
		readSettledTools,
		settleRun(runId: string, outcome: "completed" | "failed" | "cancelled") {
			const messages = outcome === "completed" ? undefined : readSettledTools(runId);
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
				"Tools execute in call order. If a tool throws with code 'interrupted', inspect its effects before retrying. Base replay-sensitive branches and arguments on stable input and tool results.",
				"Write large results to a workspace file and return the path.",
				instructions,
				scheduleInstructions,
				...describeTools(registry),
			].join("\n"),
			parameters: { ...Tool.getJsonSchema(Exec), additionalProperties: false },
		},
		service: { execute },
	};
}
