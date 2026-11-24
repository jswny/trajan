import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import type { ToolBinding } from "@cloudflare/computer/modules/tools";
import { createPiTools, forPiTools } from "@cloudflare/computer/tools/pi-ai";

export const WORKSPACE_PROMPT =
	"You are Trajan, a concise and capable assistant. You have a durable workspace at /workspace. Use exec to compose tools when they can answer the request, and explain their results plainly.";

const root = "/workspace";

export function createTrajanWorkspace(storage: DurableObjectStorage, loader: Env["LOADER"]) {
	const git = createGitModule({ allowNetwork: true });
	let bindings: ReadonlyArray<ToolBinding> = [];
	const workspace = new Workspace({
		storage,
		git: createGitClient(),
		backends: [
			new CodemodeBackend({
				loader,
				root,
				access: "read-write",
				maxResultBytes: 64 * 1024,
				modules: {
					"codemode:git": git,
					"codemode:tools": createToolBindings(() => bindings),
				},
			}),
		],
	});

	const tools = createPiTools({ workspace, root, exec: { backends: {} } });
	bindings = forPiTools(tools)();
	const instructions = [
		"Import workspace tools as named exports from codemode:tools. Each tool takes one object and returns { text, isError, details }. Check isError before using its result.",
		...tools.tools.map(
			({ name, description, parameters }) =>
				`${name}: ${description}\nArguments: ${JSON.stringify(parameters)}`,
		),
		`Import Git functions from codemode:git. ${git.description}`,
	].join("\n");
	return { workspace, instructions };
}
