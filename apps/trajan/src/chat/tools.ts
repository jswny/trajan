import { createCodeMode } from "@trajan/code-mode";
import { TurnIoError } from "@trajan/harness";
import type { ToolActivity, ToolResult, TurnTools } from "@trajan/harness";
import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { scheduleInstructions } from "../turn-schedules";
import type { TurnSchedules } from "../turn-schedules";
import { codeModeError } from "../workspace";
import { RECENT_TOOL_CALLS, readToolActivity, writeToolActivity } from "./tool-activity";

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

export function createChatTools(
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	schedules: TurnSchedules,
	{
		catalog,
		instructions,
	}: { catalog: Parameters<typeof createCodeMode>[2]; instructions: string },
) {
	const codeMode = createCodeMode(loader, storage, {
		...catalog,
		"codemode:tools": { ...catalog["codemode:tools"], ...schedules.tools },
	});
	const execute = Effect.fn("chat.exec")(
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
			const result = yield* codeMode
				.run(executionId, code, {
					scope: runId,
					recovering: attempt.recovering,
					onActivity: (entry) =>
						Effect.tryPromise({
							try: () => {
								recent = [...recent.filter(({ id }) => id !== entry.id), entry].slice(
									-RECENT_TOOL_CALLS,
								);
								writeToolActivity(storage, runId, { executionId, activity: recent });
								return storage.sync();
							},
							catch: codeModeError,
						}).pipe(
							Effect.flatMap(() => publishActivity(recent)),
							Effect.mapError(codeModeError),
						),
				})
				.pipe(
					Effect.match({
						onSuccess: (output): typeof ToolResult.Type => ({ status: "completed", output }),
						onFailure: ({ message }) => unknownOutcome(message),
					}),
				);
			return recent.length > 0 ? { ...result, activity: markInterrupted(recent) } : result;
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
				"Run a JavaScript module. Use export default async function () { ... } and return a JSON result.",
				"console.log and console.error are captured.",
				"Use registered tools for all workspace and external operations. Capabilities cannot be accessed directly by the script.",
				"Import replayable helpers from codemode:runtime for time or randomness that affects tool calls. Await now() for Unix time in milliseconds, random() for a number in [0, 1), or randomUUID() for a version 4 UUID. Each returned value is reused during replay.",
				"Tools execute in call order. If a tool throws with code 'interrupted', inspect its effects before retrying. Base replay-sensitive branches and arguments on stable input and tool results.",
				"Write large results to a workspace file and return the path.",
				instructions,
				scheduleInstructions,
			].join("\n"),
			parameters: { ...Tool.getJsonSchema(Exec), additionalProperties: false },
		},
		service: { execute },
	};
}
