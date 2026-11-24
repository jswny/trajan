import { resolve } from "node:path/posix";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { CodeModeError } from "@trajan/code-mode";
import type { CodeModeTool } from "@trajan/code-mode";
import { Effect, Predicate, Schema } from "effect";

export const WORKSPACE_PROMPT =
	"You are Trajan, a concise and capable assistant. You have a durable workspace at /workspace. Use exec to compose tools when they can answer the request, and explain their results plainly.";

const root = "/workspace";
const replaySafeFiles = new Set(["read", "ls", "find", "grep"]);
const isFileToolError = Schema.is(Schema.Struct({ isError: Schema.Literal(true) }));

export function codeModeError(cause: unknown) {
	return new CodeModeError({ message: cause instanceof Error ? cause.message : String(cause) });
}

export function createTrajanWorkspace(ctx: DurableObjectState) {
	const workspace = new Workspace({ storage: ctx.storage, git: createGitClient() });
	void ctx.blockConcurrencyWhile(() =>
		Effect.runPromise(Effect.tryPromise(() => workspace.fs.mkdir(root, { recursive: true }))),
	);
	return workspace;
}

const directory = { dir: Schema.optionalKey(Schema.String) };
const pathList = Schema.mutable(Schema.Array(Schema.NonEmptyString));
const ref = Schema.optionalKey(Schema.NonEmptyString);
const depth = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)));

function workspaceGit(workspace: Workspace) {
	const git = workspace.git;

	async function confinedDirectory(input: string | undefined, signal: AbortSignal) {
		const dir = resolve(root, input ?? ".");
		if (dir !== root && !dir.startsWith(root + "/")) {
			throw new Error("Git directory must be inside /workspace.");
		}
		let path = root;
		for (const segment of [
			"",
			...dir
				.slice(root.length + 1)
				.split("/")
				.filter(Boolean),
			".git",
		]) {
			signal.throwIfAborted();
			if (segment) {
				path += "/" + segment;
			}
			const info = await workspace.fs.lstat(path).catch((error: unknown) => {
				if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") {
					return null;
				}
				throw error;
			});
			if (!info) {
				break;
			}
			if (info.isSymbolicLink) {
				throw new Error("Git directories cannot traverse a symbolic link.");
			}
		}
		return dir;
	}

	function operation<A extends { readonly dir?: string }, B>(
		replay: CodeModeTool["replay"],
		schema: Schema.Codec<A>,
		call: (options: A) => Promise<B>,
	) {
		return {
			replay,
			schema,
			run: Effect.fnUntraced(function* (
				input: Schema.Json,
				{ signal }: Parameters<CodeModeTool["run"]>[1],
			) {
				const args = yield* Schema.decodeUnknownEffect(schema)(input ?? {});
				return yield* Effect.tryPromise({
					try: async () => {
						const dir = await confinedDirectory(args.dir, signal);
						signal.throwIfAborted();
						return (await call({ ...args, dir })) ?? null;
					},
					catch: codeModeError,
				}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)));
			}, Effect.mapError(codeModeError)),
		} satisfies CodeModeTool & { readonly schema: Schema.Constraint };
	}

	return {
		status: operation("safe", Schema.Struct(directory), (args) => git.status(args)),
		diff: operation(
			"safe",
			Schema.Struct({ ...directory, ref, to: ref, paths: Schema.optionalKey(pathList) }),
			(args) => git.diff(args),
		),
		log: operation("safe", Schema.Struct({ ...directory, ref, depth }), (args) => git.log(args)),
		branches: operation("safe", Schema.Struct(directory), (args) => git.branchList(args)),
		init: operation("unsafe", Schema.Struct(directory), (args) => git.init(args)),
		clone: operation(
			"unsafe",
			Schema.Struct({ ...directory, url: Schema.NonEmptyString, ref, depth }),
			(args) => git.clone(args),
		),
		add: operation("unsafe", Schema.Struct({ ...directory, paths: pathList }), (args) =>
			git.add(args),
		),
		commit: operation(
			"unsafe",
			Schema.Struct({
				...directory,
				message: Schema.NonEmptyString,
				author: Schema.Struct({ name: Schema.NonEmptyString, email: Schema.NonEmptyString }),
			}),
			(args) => git.commit(args),
		),
		branch: operation(
			"unsafe",
			Schema.Struct({ ...directory, name: Schema.NonEmptyString, startPoint: ref }),
			(args) => git.branch(args),
		),
		checkout: operation(
			"unsafe",
			Schema.Struct({ ...directory, ref: Schema.NonEmptyString }),
			(args) => git.checkout(args),
		),
		fetch: operation(
			"unsafe",
			Schema.Struct({ ...directory, remote: ref, ref, remoteRef: ref, depth }),
			(args) => git.fetch(args),
		),
		push: operation(
			"unsafe",
			Schema.Struct({ ...directory, remote: ref, ref, remoteRef: ref }),
			(args) => git.push(args),
		),
	};
}

export function workspaceToolset(workspace: Workspace) {
	const files = createPiTools({ workspace, root, exec: { backends: {} } });
	const fileTools = Object.fromEntries(
		files.tools.map(({ name }) => [
			name,
			{
				replay: replaySafeFiles.has(name) ? "safe" : "unsafe",
				isError: isFileToolError,
				run: Effect.fnUntraced(function* (input, { callId, signal }) {
					const result = yield* Effect.tryPromise({
						try: () => {
							signal.throwIfAborted();
							return files.execute({ id: callId, name, arguments: input });
						},
						catch: codeModeError,
					});
					const text = result.content
						.flatMap((item) => (item.type === "text" ? [item.text] : []))
						.join("\n");
					const details = yield* Schema.decodeUnknownEffect(Schema.Json)(result.details).pipe(
						Effect.orElseSucceed(() => null),
					);
					return { text, isError: result.isError, ...(details !== null && { details }) };
				}),
			} satisfies CodeModeTool,
		]),
	);
	const gitTools = workspaceGit(workspace);
	const instructions = [
		"Import named file tools from codemode:tools. Each takes an object and returns { text, isError, details? }. Check isError before using its result.",
		...files.tools.map(
			({ name, description, parameters }) =>
				`${name}: ${description}\nArguments: ${JSON.stringify(parameters)}`,
		),
		"Import named Git tools from codemode:git. The directory defaults to /workspace.",
		...Object.entries(gitTools).map(
			([name, { schema }]) =>
				`${name}: ${JSON.stringify(Schema.toJsonSchemaDocument(schema).schema)}`,
		),
	].join("\n");
	return {
		instructions,
		catalog: { "codemode:tools": fileTools, "codemode:git": gitTools },
	};
}
