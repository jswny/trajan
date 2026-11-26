import { resolve } from "node:path/posix";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type { GitClient } from "@cloudflare/computer/git";
import { CodeModeError, defineTool } from "@trajan/code-mode";
import type { CodeModeTool } from "@trajan/code-mode";
import {
	DEFAULT_WORKSPACE_SKILLS_ROOT,
	loadSkillCatalog,
	renderSkillResource,
	workspace as skillSource,
} from "agents/skills";
import type { SkillCatalog } from "agents/skills";
import { Effect, Predicate, Schema, Semaphore } from "effect";
import { filePreview } from "./chat/tool-activity";
import { FilePreview } from "./chat/tool-presentation";
import { workspaceFileTools } from "./workspace-file-changes";
import type { FileMutationReceipt } from "./workspace-file-changes";

export const WORKSPACE_PROMPT =
	"You are Trajan, a concise and capable assistant. You have a durable workspace at /workspace. Use exec to compose tools when they can answer the request, and explain their results plainly.";

const root = "/workspace";
const createWorkspaceGitClient = createGitClient();
const replaySafeFiles = new Set(["read", "ls", "find", "grep"]);
const atomicFiles = new Set(["write", "edit", "delete"]);
const isFileToolError = Schema.is(Schema.Struct({ isError: Schema.Literal(true) }));
const decodeFileRead = Schema.decodeUnknownOption(
	Schema.Struct({
		path: Schema.NonEmptyString,
		content: Schema.String,
		truncated: Schema.Boolean,
	}),
);

export function codeModeError(cause: unknown) {
	return new CodeModeError({ message: cause instanceof Error ? cause.message : String(cause) });
}

export function createTrajanWorkspace(ctx: DurableObjectState) {
	const workspace = new Workspace({ storage: ctx.storage, git: createWorkspaceGitClient });
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
		input: Schema.Codec<A>,
		call: (git: GitClient, options: A) => Promise<B>,
		recovery?: (input: A) => string,
	) {
		const invoke = Effect.fnUntraced(function* (args: A, signal: AbortSignal) {
			const dir = yield* confinedDirectory(args.dir, signal);
			const value = yield* Effect.tryPromise({
				try: () => {
					signal.throwIfAborted();
					// The client's index cache survives SQLite rollbacks and can miss index creation.
					return call(createWorkspaceGitClient({ ws: workspace }), { ...args, dir });
				},
				catch: codeModeError,
			});
			return yield* Schema.decodeUnknownEffect(Schema.Json)(value ?? null);
		});
		return defineTool({
			...(replay === "atomic" ? { replay, mutationLock: mutations } : { replay }),
			input,
			output: Schema.Json,
			normalizeInput: (raw) => raw ?? {},
			...(recovery && { recovery }),
			run: (args, { signal }) => {
				const run = invoke(args, signal);
				// Status and diff may refresh index metadata. Hold the lock until Git settles.
				return replay === "atomic" ? run : mutations.withPermit(Effect.uninterruptible(run));
			},
		});
	}

	return {
		status: operation("safe", Schema.Struct(directory), (git, args) => git.status(args)),
		diff: operation(
			"safe",
			Schema.Struct({ ...directory, ref, to: ref, paths: Schema.optionalKey(pathList) }),
			(git, args) => git.diff(args),
		),
		log: operation("safe", Schema.Struct({ ...directory, ref, depth }), (git, args) =>
			git.log(args),
		),
		branches: operation("safe", Schema.Struct(directory), (git, args) => git.branchList(args)),
		init: operation("atomic", Schema.Struct(directory), (git, args) => git.init(args)),
		clone: operation(
			"unsafe",
			Schema.Struct({ ...directory, url: Schema.NonEmptyString, ref, depth }),
			(git, args) => git.clone(args),
		),
		add: operation("atomic", Schema.Struct({ ...directory, paths: pathList }), (git, args) =>
			git.add(args),
		),
		commit: operation(
			"atomic",
			Schema.Struct({
				...directory,
				message: Schema.NonEmptyString,
				author: Schema.Struct({ name: Schema.NonEmptyString, email: Schema.NonEmptyString }),
			}),
			(git, args) => git.commit(args),
		),
		branch: operation(
			"atomic",
			Schema.Struct({ ...directory, name: Schema.NonEmptyString, startPoint: ref }),
			(git, args) => git.branch(args),
		),
		checkout: operation(
			"atomic",
			Schema.Struct({ ...directory, ref: Schema.NonEmptyString }),
			(git, args) => git.checkout(args),
		),
		fetch: operation(
			"unsafe",
			Schema.Struct({ ...directory, remote: ref, ref, remoteRef: ref, depth }),
			(git, args) => git.fetch(args),
		),
		push: operation(
			"unsafe",
			Schema.Struct({ ...directory, remote: ref, ref, remoteRef: ref }),
			(git, args) => git.push(args),
			(target) => {
				const remote = target.remote
					? `remote ${JSON.stringify(target.remote.slice(0, 128))}`
					: "the configured push remote";
				const ref = target.remoteRef
					? `ref ${JSON.stringify(target.remoteRef.slice(0, 256))}`
					: target.ref
						? `the destination for ${JSON.stringify(target.ref.slice(0, 256))}`
						: "the destination for the current branch";
				const directory = target.dir
					? ` in repository ${JSON.stringify(target.dir.slice(0, 256))}`
					: "";
				return `Remote outcome unknown. Verify ${ref} on ${remote}${directory} before retrying the push.`;
			},
		),
	};
}

const SkillName = Schema.Struct({ name: Schema.NonEmptyString });
const SkillResourceRequest = Schema.Struct({ ...SkillName.fields, path: Schema.NonEmptyString });

function workspaceSkills(workspace: Workspace) {
	function operation<A, B extends Schema.Json>(
		input: Schema.Codec<A>,
		output: Schema.Codec<B>,
		read: (
			catalog: SkillCatalog,
			input: A,
			recordDetails: (detail: typeof FilePreview.Type) => void,
		) => Effect.Effect<B, CodeModeError>,
	) {
		return defineTool({
			replay: "safe",
			input,
			output,
			details: FilePreview,
			run: Effect.fnUntraced(function* (args, { signal, recordDetails }) {
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
				return yield* read(catalog, args, recordDetails);
			}),
		});
	}

	return {
		listSkills: operation(
			Schema.NullOr(Schema.Struct({})),
			Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
			(catalog) =>
				Effect.succeed(
					catalog.skills.map(({ skill: { name, description } }) => ({ name, description })),
				),
		),
		activateSkill: operation(SkillName, Schema.String, (catalog, { name }) => {
			const activated = catalog.activate(name);
			return activated.ok
				? Effect.succeed(activated.value)
				: Effect.fail(codeModeError(activated.error));
		}),
		readSkillResource: operation(
			SkillResourceRequest,
			Schema.String,
			(catalog, input, recordDetails) =>
				Effect.gen(function* () {
					const read = yield* Effect.tryPromise({
						try: () => catalog.readResource(input),
						catch: codeModeError,
					});
					if (!read.ok) {
						return yield* codeModeError(read.error);
					}
					const { resource } = read.value;
					if (resource.encoding === "text") {
						recordDetails(filePreview(resource.path, resource.content));
					}
					return renderSkillResource(read.value);
				}),
		),
	};
}

export function workspaceToolset(workspace: Workspace) {
	const mutations = Semaphore.makeUnsafe(1);
	const files = workspaceFileTools(workspace, root);
	const fileTools = Object.fromEntries(
		files.tools.map(({ name, parameters, description }) => [
			name,
			{
				...(atomicFiles.has(name)
					? { replay: "atomic" as const, mutationLock: mutations }
					: { replay: replaySafeFiles.has(name) ? ("safe" as const) : ("unsafe" as const) }),
				parameters,
				description,
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
					if (name === "read" && !result.isError) {
						const file = decodeFileRead(details);
						if (file._tag === "Some") {
							const { path, content, truncated } = file.value;
							recordDetails(filePreview(path, content, truncated));
						}
					}
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
		"Skills are named exports from codemode:tools. Use listSkills() to find a relevant workflow, activateSkill({ name }) to load its instructions and file list, and readSkillResource({ name, path }) to read a bundled file by its skill-relative path.",
		`Use the workspace file tools to create or update skills under ${DEFAULT_WORKSPACE_SKILLS_ROOT}/<name>/SKILL.md. Start the file with YAML frontmatter containing name (matching the folder) and description. Skill tools discover saved changes on the next call.`,
		"Import named Git tools from codemode:git. The directory defaults to /workspace.",
	].join("\n");
	return {
		instructions,
		catalog: {
			"codemode:tools": tools,
			"codemode:git": gitTools,
		},
	};
}
