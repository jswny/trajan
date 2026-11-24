import { Workspace } from "@cloudflare/computer";
import type {
	WorkspaceModuleCallContext,
	WorkspaceModuleFactory,
	WorkspaceModuleHost,
} from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import type { ToolBinding, ToolBindingResult } from "@cloudflare/computer/modules/tools";
import { createPiTools, forPiTools } from "@cloudflare/computer/tools/pi-ai";
import { TurnIoError } from "@trajan/effect-harness";
import type { ToolActivity } from "@trajan/effect-harness";
import { Data, Effect, Exit, Schema } from "effect";

export const WORKSPACE_PROMPT =
	"You are Trajan, a concise and capable assistant. You have a durable workspace at /workspace. Use exec to compose tools when they can answer the request, and explain their results plainly.";

const root = "/workspace";
const replaySafeTools = new Set(["read", "ls", "find", "grep"]);
const replaySafeGitCalls = new Set(["status", "diff", "log"]);
const isGitCliResult = Schema.is(Schema.Struct({ exitCode: Schema.Int }));
type ToolCall = typeof ToolActivity.Type;
type ToolObserver = {
	readonly publish: (call: ToolCall) => Effect.Effect<void, TurnIoError>;
	readonly claimUnsafeCall: (callId: string) => Effect.Effect<boolean, TurnIoError>;
};
export type WorkspaceToolBinding = ToolBinding & { readonly replay: "safe" | "unsafe" };
type WorkspaceCall<A> = {
	readonly name: string;
	readonly replay: WorkspaceToolBinding["replay"];
	readonly execute: () => Promise<A> | A;
	readonly isError: (result: A) => boolean;
};

class WorkspaceCallUnavailable extends Data.TaggedError("WorkspaceCallUnavailable")<{
	readonly code: "ended" | "interrupted";
	readonly message: string;
}> {}

function endedCall() {
	return new WorkspaceCallUnavailable({ code: "ended", message: "The tool execution has ended." });
}

export function createObservedWorkspaceTools(bindings: () => ReadonlyArray<WorkspaceToolBinding>) {
	const observers = new Map<string, ToolObserver>();
	const callTool = Effect.fn("workspace.toolCall")(function* <A>(
		{ name, replay, execute, isError }: WorkspaceCall<A>,
		context: WorkspaceModuleCallContext,
	) {
		const { id } = context.execution;
		const observer = observers.get(id);
		if (!observer) {
			return yield* endedCall();
		}
		const publish = (status: ToolCall["status"]) =>
			Effect.suspend(() =>
				observers.get(id) === observer
					? observer.publish({ id: context.callId, name, status })
					: Effect.void,
			);
		if (replay === "unsafe" && !(yield* observer.claimUnsafeCall(context.callId))) {
			yield* publish("interrupted");
			return yield* new WorkspaceCallUnavailable({
				code: "interrupted",
				message:
					"This call was interrupted and may already have applied changes. Inspect its effects before retrying.",
			});
		}
		yield* publish("running");
		return yield* Effect.tryPromise({
			try: async () => {
				context.signal.throwIfAborted();
				if (observers.get(id) !== observer) {
					throw endedCall();
				}
				return execute();
			},
			catch: (cause) =>
				new TurnIoError({
					operation: name,
					cause,
					message: cause instanceof Error ? cause.message : String(cause),
				}),
		}).pipe(
			Effect.onExit((exit) => {
				if (Exit.isSuccess(exit)) {
					return publish(isError(exit.value) ? "failed" : "completed");
				}
				return publish(context.signal.aborted ? "interrupted" : "failed");
			}),
		);
	});
	return {
		tools: createToolBindings(() =>
			bindings().map((binding) => ({
				...binding,
				call: (input, context) =>
					Effect.runPromise(
						callTool(
							{
								name: binding.name,
								replay: binding.replay,
								execute: () => binding.call(input, context),
								isError: (result) => result.isError,
							},
							context,
						).pipe(
							Effect.catchTag("WorkspaceCallUnavailable", ({ code, message }) =>
								Effect.succeed<ToolBindingResult>(
									code === "interrupted"
										? { text: message, isError: true, details: { code } }
										: { text: message, isError: true },
								),
							),
						),
						{ signal: context.signal },
					),
			})),
		),
		git(factory: WorkspaceModuleFactory): WorkspaceModuleFactory {
			return Object.assign(
				(host: WorkspaceModuleHost) =>
					Object.fromEntries(
						Object.entries(factory(host)).map(([name, call]) => [
							name,
							(...[args, context]: Parameters<typeof call>) =>
								Effect.runPromise(
									callTool(
										{
											name: `git.${name}`,
											replay: replaySafeGitCalls.has(name) ? "safe" : "unsafe",
											execute: () => call(args, context),
											isError: (result) =>
												name === "cli" && isGitCliResult(result) && result.exitCode !== 0,
										},
										context,
									),
									{ signal: context.signal },
								),
						]),
					),
				{ description: factory.description ?? "Git operations for the workspace." },
			);
		},
		observeExecution(this: void, id: string, observer: ToolObserver) {
			observers.set(id, observer);
			return () => {
				if (observers.get(id) === observer) {
					observers.delete(id);
				}
			};
		},
	};
}

export function workspaceToolset(workspace: Workspace) {
	const tools = createPiTools({ workspace, root, exec: { backends: {} } });
	return {
		declarations: tools.tools,
		bindings: forPiTools(tools)().map<WorkspaceToolBinding>((binding) => ({
			...binding,
			replay: replaySafeTools.has(binding.name) ? "safe" : "unsafe",
		})),
	};
}

export function createTrajanWorkspace(storage: DurableObjectStorage, loader: Env["LOADER"]) {
	const git = createGitModule({ allowNetwork: true });
	let bindings: ReadonlyArray<WorkspaceToolBinding> = [];
	const toolsModule = createObservedWorkspaceTools(() => bindings);
	const workspace = new Workspace({
		storage,
		git: createGitClient(),
		backends: [
			new CodemodeBackend({
				loader,
				root,
				access: "read-write",
				onInterrupt: "fail",
				maxResultBytes: 64 * 1024,
				modules: {
					"codemode:git": toolsModule.git(git),
					"codemode:tools": toolsModule.tools,
				},
			}),
		],
	});

	const tools = workspaceToolset(workspace);
	bindings = tools.bindings;
	const instructions = [
		"Import workspace tools as named exports from codemode:tools. Each tool takes one object and returns { text, isError, details }. Check isError before using its result.",
		"Prefer these tools for ordinary file operations so chat can show their progress.",
		...tools.declarations.map(
			({ name, description, parameters }) =>
				`${name}: ${description}\nArguments: ${JSON.stringify(parameters)}`,
		),
		`Import Git functions from codemode:git. ${git.description}`,
	].join("\n");
	return { workspace, instructions, observeExecution: toolsModule.observeExecution };
}
