import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import type { ToolBinding, ToolBindingResult } from "@cloudflare/computer/modules/tools";
import { createPiTools, forPiTools } from "@cloudflare/computer/tools/pi-ai";
import { TurnIoError } from "@trajan/effect-harness";
import type { ToolActivity } from "@trajan/effect-harness";
import { Effect, Exit } from "effect";

export const WORKSPACE_PROMPT =
	"You are Trajan, a concise and capable assistant. You have a durable workspace at /workspace. Use exec to compose tools when they can answer the request, and explain their results plainly.";

const root = "/workspace";
const replaySafeTools = new Set(["read", "ls", "find", "grep"]);
type ToolCall = typeof ToolActivity.Type;
type ToolObserver = {
	readonly publish: (call: ToolCall) => Effect.Effect<void, TurnIoError>;
	readonly claimUnsafeCall: (callId: string) => Effect.Effect<boolean, TurnIoError>;
};
export type WorkspaceToolBinding = ToolBinding & { readonly replay: "safe" | "unsafe" };
const interruptedTool = {
	text: "This call was interrupted and may already have applied changes. Inspect its effects before retrying.",
	isError: true,
	details: { code: "interrupted" },
} satisfies ToolBindingResult;

export function createObservedToolBindings(bindings: () => ReadonlyArray<WorkspaceToolBinding>) {
	const observers = new Map<string, ToolObserver>();
	const callTool = Effect.fn("workspace.toolCall")(function* (
		binding: WorkspaceToolBinding,
		...[input, context]: Parameters<ToolBinding["call"]>
	) {
		const { id } = context.execution;
		const observer = observers.get(id);
		if (!observer) {
			return { text: "The tool execution has ended.", isError: true };
		}
		const publish = (status: ToolCall["status"]) =>
			Effect.suspend(() =>
				observers.get(id) === observer
					? observer.publish({ id: context.callId, name: binding.name, status })
					: Effect.void,
			);
		if (binding.replay === "unsafe" && !(yield* observer.claimUnsafeCall(context.callId))) {
			yield* publish("interrupted");
			return interruptedTool;
		}
		yield* publish("running");
		return yield* Effect.tryPromise({
			try: async () => {
				context.signal.throwIfAborted();
				if (observers.get(id) !== observer) {
					throw new Error("The tool execution has ended.");
				}
				return binding.call(input, context);
			},
			catch: (cause) =>
				new TurnIoError({
					operation: binding.name,
					cause,
					message: cause instanceof Error ? cause.message : String(cause),
				}),
		}).pipe(
			Effect.onExit((exit) => {
				if (Exit.isSuccess(exit)) {
					return publish(exit.value.isError ? "failed" : "completed");
				}
				return publish(context.signal.aborted ? "interrupted" : "failed");
			}),
		);
	});
	return {
		module: createToolBindings(() =>
			bindings().map((binding) => ({
				...binding,
				call: (input, context) =>
					Effect.runPromise(callTool(binding, input, context), { signal: context.signal }),
			})),
		),
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
	const toolsModule = createObservedToolBindings(() => bindings);
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
					"codemode:git": git,
					"codemode:tools": toolsModule.module,
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
