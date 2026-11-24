import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import type { ToolBinding } from "@cloudflare/computer/modules/tools";
import { createPiTools, forPiTools } from "@cloudflare/computer/tools/pi-ai";
import { TurnIoError } from "@trajan/effect-harness";
import type { ToolActivity } from "@trajan/effect-harness";
import { Effect, Exit } from "effect";

export const WORKSPACE_PROMPT =
	"You are Trajan, a concise and capable assistant. You have a durable workspace at /workspace. Use exec to compose tools when they can answer the request, and explain their results plainly.";

const root = "/workspace";
type ToolCall = typeof ToolActivity.Type;
type ToolObserver = (call: ToolCall) => Effect.Effect<void>;

export function createObservedToolBindings(bindings: () => ReadonlyArray<ToolBinding>) {
	const observers = new Map<string, ToolObserver>();
	const callTool = Effect.fn("workspace.toolCall")(function* (
		binding: ToolBinding,
		...[input, context]: Parameters<ToolBinding["call"]>
	) {
		const { id } = context.execution;
		const observer = observers.get(id);
		const publish = (status: ToolCall["status"]) =>
			Effect.suspend(() =>
				observer && observers.get(id) === observer
					? observer({ id: context.callId, name: binding.name, status })
					: Effect.void,
			);
		yield* publish("running");
		return yield* Effect.tryPromise({
			try: async () => binding.call(input, context),
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

export function createTrajanWorkspace(storage: DurableObjectStorage, loader: Env["LOADER"]) {
	const git = createGitModule({ allowNetwork: true });
	let bindings: ReadonlyArray<ToolBinding> = [];
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

	const tools = createPiTools({ workspace, root, exec: { backends: {} } });
	bindings = forPiTools(tools)();
	const instructions = [
		"Import workspace tools as named exports from codemode:tools. Each tool takes one object and returns { text, isError, details }. Check isError before using its result.",
		"Prefer these tools for ordinary file operations so chat can show their progress.",
		...tools.tools.map(
			({ name, description, parameters }) =>
				`${name}: ${description}\nArguments: ${JSON.stringify(parameters)}`,
		),
		`Import Git functions from codemode:git. ${git.description}`,
	].join("\n");
	return { workspace, instructions, observeExecution: toolsModule.observeExecution };
}
