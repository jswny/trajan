import type { Workspace } from "@cloudflare/computer";
import { renderToolSignature } from "@earendil-works/pi-codemode/declarations";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import type { CodemodeRemote, CodemodeTool } from "@earendil-works/pi-codemode/portable";
import { TurnIoError } from "@trajan/effect-harness";
import type { ToolResult, TurnTools } from "@trajan/effect-harness";
import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { computerToolset, REPLAY_SAFE } from "../workspace";

const Code = Schema.Struct({ code: Schema.NonEmptyString });
const Codemode = Tool.make("codemode", { parameters: Code, success: Schema.Json });

function toolError(cause: unknown): Extract<typeof ToolResult.Type, { status: "failed" }> {
	return {
		status: "failed",
		message: cause instanceof Error ? cause.message : String(cause),
	};
}

function unknownOutcome(message: string): Extract<typeof ToolResult.Type, { status: "unknown" }> {
	return {
		status: "unknown",
		message: `${message} The tool may have changed the workspace. Inspect it before repeating the action.`,
	};
}

export function effectWorkspaceTools(workspace: Workspace, remote: () => CodemodeRemote) {
	const computer = computerToolset(workspace);
	const direct = computer.tools.filter((tool) => tool.name !== "exec");

	const sandboxTools = computer.tools.map((tool): CodemodeTool => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		async execute(input, { signal }) {
			const result = await computer.execute(
				{ id: crypto.randomUUID(), name: tool.name, arguments: input },
				{ abortSignal: signal },
			);
			if (result.isError) {
				const message = result.content.find((part) => part.type === "text")?.text;
				throw new Error(message ?? `The ${tool.name} tool failed.`);
			}
			return result.content;
		},
	}));

	const declaration = {
		name: Codemode.name,
		description: [
			"Run an async JavaScript function body in a sandbox to compose workspace tools. Use await tools.name(args) and return the result or call text(value). Tools resolve to content parts. The script has no network or imports.",
			...sandboxTools.map((tool) => `tools.${renderToolSignature(tool)}`),
			sandboxTools.find((tool) => tool.name === "exec")?.description,
		].join("\n"),
		parameters: Tool.getJsonSchema(Codemode),
	};

	const runCode = Effect.fn("effect-harness.codemode")(
		function* (input: Schema.Json) {
			const { code } = yield* Schema.decodeUnknownEffect(Code)(input);
			const result = yield* Effect.acquireUseRelease(
				Effect.sync(() => new RemoteCodemodeSandbox({ remote, tools: sandboxTools })),
				(sandbox) =>
					Effect.tryPromise({
						try: (signal) => sandbox.execute(code, { signal }),
						catch: (cause) =>
							new TurnIoError({ operation: "codemode", cause, message: toolError(cause).message }),
					}),
				(sandbox) => Effect.promise(() => sandbox.close()),
			);
			if (!result.ok) {
				return result.error.kind === "script" && result.calls.length === 0
					? toolError(result.error.message)
					: unknownOutcome(result.error.message);
			}
			const output = yield* Schema.decodeUnknownEffect(Schema.Json)({
				value: result.value ?? null,
				content: result.output,
			});
			return { status: "completed", output } as const;
		},
		Effect.catch((error) =>
			Effect.succeed(
				error instanceof TurnIoError ? unknownOutcome(error.message) : toolError(error),
			),
		),
	);

	const execute = Effect.fn("effect-harness.workspaceTool")(function* (
		call: Parameters<TurnTools["Service"]["execute"]>[0],
		attempt: Parameters<TurnTools["Service"]["execute"]>[1],
	): Effect.fn.Return<typeof ToolResult.Type> {
		if (attempt.recovering && !REPLAY_SAFE.has(call.name)) {
			return unknownOutcome("The tool was interrupted.");
		}
		if (call.name === Codemode.name) {
			return yield* runCode(call.input);
		}
		if (!direct.some((tool) => tool.name === call.name)) {
			return toolError(`Unknown workspace tool: ${call.name}`);
		}
		return yield* Effect.tryPromise({
			try: (signal) =>
				computer.execute(
					{ id: attempt.idempotencyKey, name: call.name, arguments: call.input },
					{ abortSignal: signal },
				),
			catch: toolError,
		}).pipe(
			Effect.match({
				onFailure: (failure) => failure,
				onSuccess: ({ content, isError }) =>
					isError
						? toolError(
								content.find((part) => part.type === "text")?.text ?? "Workspace tool failed.",
							)
						: { status: "completed" as const, output: content },
			}),
		);
	});

	return { declarations: [...direct, declaration], service: { execute } };
}
