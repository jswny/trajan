import { resolve } from "node:path/posix";
import type { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type { GitClient } from "@cloudflare/computer/git";
import { CodeModeError, codeModeError, defineTool } from "@trajan/code-mode";
import type { CodeModeTool } from "@trajan/code-mode";
import { Effect, Predicate, Schema } from "effect";
import type { Semaphore } from "effect";

export const createWorkspaceGitClient = createGitClient();

const directory = { dir: Schema.optionalKey(Schema.String) };
const pathList = Schema.mutable(Schema.Array(Schema.NonEmptyString));
const ref = Schema.optionalKey(Schema.NonEmptyString);
const depth = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)));

export function workspaceGit(workspace: Workspace, root: string, mutations: Semaphore.Semaphore) {
	const confinedDirectory = Effect.fnUntraced(function* (
		input: string | undefined,
		signal: AbortSignal,
	) {
		const dir = resolve(root, input ?? ".");
		if (dir !== root && !dir.startsWith(root + "/")) {
			return yield* new CodeModeError({ message: `Git directory must be inside ${root}.` });
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
