import { TurnIoError } from "@trajan/effect-harness";
import type { StepAttempt, ToolActivity, ToolResult, TurnTools } from "@trajan/effect-harness";
import { Effect, Exit, Schema } from "effect";
import { Tool } from "effect/ai";
import type { createTrajanWorkspace } from "../workspace";
import {
	RECENT_TOOL_CALLS,
	claimToolIntent,
	readToolActivity,
	writeToolActivity,
} from "./tool-activity";

const Code = Schema.Struct({ code: Schema.NonEmptyString });
const Exec = Tool.make("exec", { parameters: Code, success: Schema.Json });

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
		message: `${message} The script may have changed the workspace. Inspect it before repeating the action.`,
	};
}

function markInterrupted(activity: ReadonlyArray<typeof ToolActivity.Type>) {
	return activity.map((entry) =>
		entry.status === "running" ? { ...entry, status: "interrupted" as const } : entry,
	);
}

export function effectWorkspaceTools(
	{ workspace, instructions, observeExecution }: ReturnType<typeof createTrajanWorkspace>,
	storage: DurableObjectStorage,
) {
	const runScript = Effect.fnUntraced(
		function* (
			code: string,
			attempt: StepAttempt,
		): Effect.fn.Return<typeof ToolResult.Type, TurnIoError> {
			const runtime = workspace.runtime;
			const result = yield* Effect.acquireUseRelease(
				Effect.tryPromise({
					// A missing execution can no longer prove that a mutation didn't happen.
					try: () =>
						attempt.recovering
							? runtime.getExec(attempt.idempotencyKey, { encoding: "utf8" })
							: runtime.exec(code, {
									id: attempt.idempotencyKey,
									encoding: "utf8",
									output: { maxBytes: 16 * 1024 },
								}),
					catch: executionError,
				}),
				(handle) => Effect.tryPromise({ try: () => handle.result(), catch: executionError }),
				(handle, exit) =>
					Effect.gen(function* () {
						if (Exit.hasInterrupts(exit)) {
							yield* Effect.tryPromise({ try: () => handle.kill(), catch: executionError }).pipe(
								Effect.ignore,
							);
						}
						yield* Effect.sync(() => handle[Symbol.dispose]());
					}),
			);
			const { value, stdout, stderr, truncated } = result;
			if (result.status !== "completed") {
				return unknownOutcome(stderr.trim() || `Execution ended with status ${result.status}.`);
			}
			const output = yield* Schema.decodeUnknownEffect(Schema.Json)(
				stdout || stderr || truncated
					? { value: value ?? null, stdout, stderr, ...(truncated && { truncated }) }
					: (value ?? null),
			).pipe(Effect.mapError(executionError));
			return { status: "completed", output };
		},
		Effect.catch((error) => Effect.succeed(unknownOutcome(error.message))),
	);
	const execute = Effect.fn("effect-harness.exec")(
		function* (...[call, attempt, publishActivity]: Parameters<TurnTools["Service"]["execute"]>) {
			if (call.name !== Exec.name) {
				return { status: "failed" as const, message: `Unknown tool: ${call.name}` };
			}
			const { code } = yield* Schema.decodeUnknownEffect(Code)(call.input);
			const { runId, idempotencyKey: executionId } = attempt;
			const saved = yield* Effect.try({
				try: () => readToolActivity(storage, runId),
				catch: executionError,
			});
			let recent = saved?.executionId === executionId ? markInterrupted(saved.activity) : [];
			if (recent.length > 0) {
				yield* publishActivity(recent);
			}
			const result = yield* Effect.acquireUseRelease(
				Effect.sync(() =>
					observeExecution(executionId, {
						claimUnsafeCall: (callId) =>
							Effect.tryPromise({
								try: async () => {
									const claimed = claimToolIntent(storage, runId, executionId, callId);
									if (claimed) {
										// Commit intent before a call can mutate anything outside this journal.
										await storage.sync();
									}
									return claimed;
								},
								catch: executionError,
							}),
						publish: (entry) =>
							Effect.tryPromise({
								try: () => {
									const activity = [...recent.filter(({ id }) => id !== entry.id), entry].slice(
										-RECENT_TOOL_CALLS,
									);
									writeToolActivity(storage, runId, { executionId, activity });
									recent = activity;
									return storage.sync();
								},
								catch: executionError,
							}).pipe(Effect.flatMap(() => publishActivity(recent))),
					}),
				),
				() => runScript(code, attempt),
				(unsubscribe) => Effect.sync(unsubscribe),
			);
			if (recent.length === 0) {
				return result;
			}
			return { ...result, activity: markInterrupted(recent) };
		},
		Effect.catch((error) =>
			Effect.succeed(
				error instanceof TurnIoError
					? unknownOutcome(error.message)
					: {
							status: "failed" as const,
							message: "Provide non-empty JavaScript source in the code argument.",
						},
			),
		),
	);

	return {
		declaration: {
			name: Exec.name,
			description: [
				"Run JavaScript ES module source in the /workspace sandbox. Use export default async function () { ... } and return the result. console.log and console.error are also captured.",
				"Write large results to a workspace file and return the path.",
				"Use this for every tool call. The sandbox also supports node:fs/promises and relative imports of workspace .js files. It has no shell, package installation, or direct network access.",
				instructions,
			].join("\n"),
			parameters: Tool.getJsonSchema(Exec),
		},
		service: { execute },
	};
}
