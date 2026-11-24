import type { Workspace } from "@cloudflare/computer";
import { TurnIoError } from "@trajan/effect-harness";
import type { ToolResult, TurnTools } from "@trajan/effect-harness";
import { Effect, Exit, Schema } from "effect";
import { Tool } from "effect/ai";

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

export function effectWorkspaceTools(workspace: Workspace, instructions: string) {
	const execute = Effect.fn("effect-harness.exec")(
		function* (
			...[call, attempt]: Parameters<TurnTools["Service"]["execute"]>
		): Effect.fn.Return<typeof ToolResult.Type, TurnIoError | Schema.SchemaError> {
			if (call.name !== Exec.name) {
				return { status: "failed", message: `Unknown tool: ${call.name}` };
			}
			const { code } = yield* Schema.decodeUnknownEffect(Code)(call.input);
			const runtime = workspace.runtime;
			const result = yield* Effect.acquireUseRelease(
				Effect.tryPromise({
					// A missing execution can no longer prove that a mutation didn't happen.
					try: () =>
						attempt.recovering
							? runtime.getExec(attempt.idempotencyKey, { encoding: "utf8" })
							: runtime.exec(code, {
									id: attempt.idempotencyKey,
									onInterrupt: "fail",
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
