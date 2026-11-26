import { resolve } from "node:path/posix";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { CodeModeError } from "@trajan/code-mode";
import type { CodeModeTool } from "@trajan/code-mode";
import {
	DEFAULT_WORKSPACE_SKILLS_ROOT,
	loadSkillCatalog,
	renderSkillResource,
	workspace as skillSource,
} from "agents/skills";
import type { SkillCatalog } from "agents/skills";
import { Effect, Predicate, Schema, Semaphore } from "effect";
import { workspaceFileTools } from "./workspace-file-changes";
import type { FileMutationReceipt } from "./workspace-file-changes";

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

function workspaceGit(workspace: Workspace, mutations: Semaphore.Semaphore) {
	const git = workspace.git;

	const confinedDirectory = Effect.fnUntraced(function* (
		input: string | undefined,
		signal: AbortSignal,
	) {
		const dir = resolve(root, input ?? ".");
		if (dir !== root && !dir.startsWith(root + "/")) {
			return yield* new CodeModeError({ message: "Git directory must be inside /workspace." });
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
			if (signal.aborted) {
				return yield* codeModeError(signal.reason);
			}
			if (segment) {
				path += "/" + segment;
			}
			const info = yield* Effect.tryPromise(() => workspace.fs.lstat(path)).pipe(
				Effect.catch(({ cause }) =>
					Predicate.hasProperty(cause, "code") && cause.code === "ENOENT"
						? Effect.succeed(null)
						: Effect.fail(codeModeError(cause)),
				),
			);
			if (!info) {
				break;
			}
			if (info.isSymbolicLink) {
				return yield* new CodeModeError({
					message: "Git directories cannot traverse a symbolic link.",
				});
			}
		}
		return dir;
	});

	function operation<A extends { readonly dir?: string }, B>(
		replay: CodeModeTool["replay"],
		schema: Schema.Codec<A>,
		call: (options: A) => Promise<B>,
	) {
		const invoke = Effect.fnUntraced(
			function* (input: Schema.Json, { signal }: Parameters<CodeModeTool["run"]>[1]) {
				const args = yield* Schema.decodeUnknownEffect(schema)(input ?? {});
				const dir = yield* confinedDirectory(args.dir, signal);
				const value = yield* Effect.tryPromise({
					try: () => {
						signal.throwIfAborted();
						return call({ ...args, dir });
					},
					catch: codeModeError,
				});
				return yield* Schema.decodeUnknownEffect(Schema.Json)(value ?? null);
			},
			Effect.catchTag("SchemaError", (error) => Effect.fail(codeModeError(error))),
		);
		return {
			replay,
			schema,
			run: (input, context) => {
				const effect = invoke(input, context);
				return replay === "unsafe" ? mutations.withPermit(effect) : effect;
			},
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

const SkillName = Schema.Struct({ name: Schema.NonEmptyString });
const SkillResourceRequest = Schema.Struct({ ...SkillName.fields, path: Schema.NonEmptyString });

function workspaceSkills(workspace: Workspace) {
	function operation<A>(
		schema: Schema.Codec<A>,
		read: (catalog: SkillCatalog, input: A) => Effect.Effect<Schema.Json, CodeModeError>,
	): CodeModeTool {
		return {
			replay: "safe",
			run: Effect.fnUntraced(
				function* (raw, { signal }) {
					const input = yield* Schema.decodeUnknownEffect(schema)(raw);
					const catalog = yield* Effect.tryPromise({
						try: () => {
							signal.throwIfAborted();
							return loadSkillCatalog([skillSource(workspace)]);
						},
						catch: codeModeError,
					});
					const failure = catalog.diagnostics.find(
						(diagnostic) => diagnostic._tag === "SourceFailed",
					);
					if (failure) {
						return yield* codeModeError(failure.error);
					}
					return yield* read(catalog, input);
				},
				Effect.catchTag("SchemaError", (error) => Effect.fail(codeModeError(error))),
			),
		};
	}

	return {
		listSkills: operation(Schema.NullOr(Schema.Struct({})), (catalog) =>
			Effect.succeed(
				catalog.skills.map(({ skill: { name, description } }) => ({ name, description })),
			),
		),
		activateSkill: operation(SkillName, (catalog, { name }) => {
			const activated = catalog.activate(name);
			return activated.ok
				? Effect.succeed(activated.value)
				: Effect.fail(codeModeError(activated.error));
		}),
		readSkillResource: operation(SkillResourceRequest, (catalog, input) =>
			Effect.gen(function* () {
				const read = yield* Effect.tryPromise({
					try: () => catalog.readResource(input),
					catch: codeModeError,
				});
				if (!read.ok) {
					return yield* codeModeError(read.error);
				}
				return renderSkillResource(read.value);
			}),
		),
	};
}

export function workspaceToolset(workspace: Workspace) {
	const mutations = Semaphore.makeUnsafe(1);
	const files = workspaceFileTools(workspace, root, mutations);
	const fileTools = Object.fromEntries(
		files.tools.map(({ name }) => [
			name,
			{
				replay: replaySafeFiles.has(name) ? "safe" : "unsafe",
				isError: isFileToolError,
				run: Effect.fnUntraced(function* (input, { callId, signal, recordDetails }) {
					const { result, observed } = yield* files
						.execute({ id: callId, name, arguments: input }, { abortSignal: signal })
						.pipe(Effect.mapError(({ cause }) => codeModeError(cause)));
					const text = result.content
						.flatMap((item) => (item.type === "text" ? [item.text] : []))
						.join("\n");
					if (name === "write" || name === "edit") {
						if (result.isError) {
							return { text, isError: true } satisfies typeof FileMutationReceipt.Type;
						}
						if (!observed) {
							return yield* new CodeModeError({
								message:
									"The file tool returned without a write receipt. Inspect the workspace before retrying.",
							});
						}
						const { path, bytesWritten, change } = observed;
						const details = { path, bytesWritten };
						if (change) {
							recordDetails(change);
						}
						return {
							text: JSON.stringify(details),
							isError: false,
							details,
						} satisfies typeof FileMutationReceipt.Type;
					}
					const details = yield* Schema.decodeUnknownEffect(Schema.Json)(result.details).pipe(
						Effect.orElseSucceed(() => null),
					);
					return { text, isError: result.isError, ...(details !== null && { details }) };
				}),
			} satisfies CodeModeTool,
		]),
	);
	const gitTools = workspaceGit(workspace, mutations);
	const tools = Object.assign(fileTools, workspaceSkills(workspace));
	const instructions = [
		"Import named file tools from codemode:tools. Each takes an object and returns { text, isError, details? }. Check isError before using its result.",
		"Successful write and edit calls both return details: { path, bytesWritten }.",
		...files.tools.map(
			({ name, description, parameters }) =>
				`${name}: ${description}\nArguments: ${JSON.stringify(parameters)}`,
		),
		"Skills are named exports from codemode:tools. Use listSkills() to find a relevant workflow, activateSkill({ name }) to load its instructions and file list, and readSkillResource({ name, path }) to read a bundled file by its skill-relative path.",
		`Use the workspace file tools to create or update skills under ${DEFAULT_WORKSPACE_SKILLS_ROOT}/<name>/SKILL.md. Start the file with YAML frontmatter containing name (matching the folder) and description. Skill tools discover saved changes on the next call.`,
		"Import named Git tools from codemode:git. The directory defaults to /workspace.",
		...Object.entries(gitTools).map(
			([name, { schema }]) =>
				`${name}: ${JSON.stringify(Schema.toJsonSchemaDocument(schema).schema)}`,
		),
	].join("\n");
	return {
		instructions,
		catalog: {
			"codemode:tools": tools,
			"codemode:git": gitTools,
		},
	};
}
