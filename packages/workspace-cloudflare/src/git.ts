import { resolve } from "node:path/posix";
import type { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import type { GitClient } from "@cloudflare/computer/git";
import { CodeModeError, codeModeError, defineReconciledTool, defineTool } from "@trajan/code-mode";
import type { CodeModeTool } from "@trajan/code-mode";
import { Effect, Option, Predicate, Schema } from "effect";
import { listServerRefs } from "isomorphic-git";
import type { workspaceLocks } from "./locks";

export const createWorkspaceGitClient = createGitClient();

const directory = { dir: Schema.optionalKey(Schema.String) };
const pathList = Schema.mutable(Schema.Array(Schema.NonEmptyString));
const ref = Schema.optionalKey(Schema.NonEmptyString);
const depth = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)));
const PushInput = Schema.Struct({ ...directory, remote: ref, ref, remoteRef: ref });
const PushIntent = Schema.NullOr(
	Schema.Struct({
		directory: Schema.NonEmptyString,
		remote: Schema.NonEmptyString,
		remoteRef: Schema.NonEmptyString,
		source: Schema.NonEmptyString,
		oid: Schema.NonEmptyString,
		endpoint: Schema.NonEmptyString,
	}),
);

function gitConfig(client: GitClient, dir: string, path: string) {
	return Effect.tryPromise({
		try: async () => {
			const value = await client.configGet({ dir, path });
			return typeof value === "string" ? value : undefined;
		},
		catch: codeModeError,
	});
}

const pushEndpoint = Effect.fnUntraced(function* (client: GitClient, dir: string, remote: string) {
	const url =
		(yield* gitConfig(client, dir, `remote.${remote}.pushurl`)) ||
		(yield* gitConfig(client, dir, `remote.${remote}.url`));
	const corsProxy = yield* gitConfig(client, dir, "http.corsProxy");
	if (!url) {
		return yield* new CodeModeError({ message: "The Git remote has no push URL." });
	}
	const endpoint = yield* Effect.tryPromise({
		try: () =>
			crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([url, corsProxy]))),
		catch: codeModeError,
	}).pipe(
		Effect.map((digest) => new Uint8Array(digest)),
		Effect.flatMap(Schema.encodeEffect(Schema.Uint8ArrayFromHex)),
	);
	return { url, corsProxy, endpoint };
});

export function workspaceGit(
	workspace: Workspace,
	root: string,
	locks: ReturnType<typeof workspaceLocks>,
) {
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
			...(replay === "atomic"
				? { replay, mutationLock: locks.repository }
				: {
						replay,
						// Status and diff may refresh index metadata.
						lock: replay === "safe" ? locks.repository : locks.remoteGit,
						localStorage: replay === "safe",
						exclusiveStorage: replay === "unsafe",
					}),
			input,
			output: Schema.Json,
			normalizeInput: (raw) => raw ?? {},
			run: (args, { signal }) => Effect.uninterruptible(invoke(args, signal)),
		});
	}

	const push = defineReconciledTool({
		input: PushInput,
		intent: PushIntent,
		output: Schema.Json,
		normalizeInput: (raw) => raw ?? {},
		lock: locks.remoteGit,
		exclusiveStorage: true,
		prepare: Effect.fnUntraced(function* (args, signal) {
			const dir = yield* confinedDirectory(args.dir, signal);
			const git = createWorkspaceGitClient({ ws: workspace });
			// Match the push client's config precedence, without saving credentials from the URL.
			const prepare = Effect.gen(function* () {
				const source = args.ref ?? (yield* Effect.tryPromise(() => git.currentBranch({ dir })));
				if (!source) {
					return null;
				}
				const remote =
					args.remote ||
					(yield* gitConfig(git, dir, `branch.${source}.pushRemote`)) ||
					(yield* gitConfig(git, dir, "remote.pushDefault")) ||
					(yield* gitConfig(git, dir, `branch.${source}.remote`)) ||
					"origin";
				let target = args.remoteRef || (yield* gitConfig(git, dir, `branch.${source}.merge`));
				if (!target) {
					if (source.startsWith("refs/")) {
						target = source;
					} else {
						const [branches, tags] = yield* Effect.tryPromise(() =>
							Promise.all([git.branchList({ dir }), git.tagList({ dir })]),
						);
						if (branches.includes(source) && !tags.includes(source)) {
							target = `refs/heads/${source}`;
						}
					}
				}
				// A shorthand destination can select a branch or tag based on the remote's state at push time.
				if (!target?.startsWith("refs/")) {
					return null;
				}
				const oid = yield* Effect.tryPromise(() => git.revParse({ dir, ref: source }));
				const { endpoint } = yield* pushEndpoint(git, dir, remote);
				return { directory: dir, remote, remoteRef: target, source, oid, endpoint };
			});
			return yield* prepare.pipe(Effect.orElseSucceed(() => null));
		}),
		run: (args, { signal }, intent) =>
			Effect.gen(function* () {
				const dir = yield* confinedDirectory(args.dir, signal);
				const git = createWorkspaceGitClient({ ws: workspace });
				if (intent) {
					const oid = yield* Effect.tryPromise(() => git.revParse({ dir, ref: intent.source }));
					const { endpoint } = yield* pushEndpoint(git, dir, intent.remote);
					if (dir !== intent.directory || oid !== intent.oid || endpoint !== intent.endpoint) {
						return yield* new CodeModeError({
							message: "The Git push target changed before execution.",
						});
					}
				}
				return yield* Effect.tryPromise({
					try: () => {
						signal.throwIfAborted();
						return git.push({
							...args,
							dir,
							...(intent && {
								ref: intent.source,
								remote: intent.remote,
								remoteRef: intent.remoteRef,
							}),
						});
					},
					catch: codeModeError,
				}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)));
			}),
		reconcile: Effect.fnUntraced(function* (intent, signal) {
			if (!intent) {
				return Option.none();
			}
			const dir = yield* confinedDirectory(intent.directory.slice(root.length + 1), signal);
			const git = createWorkspaceGitClient({ ws: workspace });
			const { url, corsProxy, endpoint } = yield* pushEndpoint(git, dir, intent.remote);
			if (endpoint !== intent.endpoint) {
				return Option.none();
			}
			const refs = yield* Effect.tryPromise({
				try: (checkSignal) =>
					listServerRefs({
						http: {
							request: async ({ url, headers }) => {
								const response = await fetch(url, {
									headers: headers ?? {},
									signal: AbortSignal.any([signal, checkSignal]),
								});
								return {
									url: response.url,
									statusCode: response.status,
									statusMessage: response.statusText,
									headers: Object.fromEntries(response.headers),
									body: (async function* () {
										yield new Uint8Array(await response.arrayBuffer());
									})(),
								};
							},
						},
						url,
						corsProxy,
						forPush: true,
						protocolVersion: 1,
					}),
				catch: codeModeError,
			});
			if (!refs.some(({ ref, oid }) => ref === intent.remoteRef && oid === intent.oid)) {
				return Option.none();
			}
			return Option.some({
				ok: true,
				error: null,
				refs: { [intent.remoteRef]: { ok: true } },
				reconciled: true,
			});
		}),
		recovery: (target) => {
			const remote = target.remote
				? `remote ${JSON.stringify(target.remote.slice(0, 128))}`
				: "the configured push remote";
			const destination = target.remoteRef
				? `ref ${JSON.stringify(target.remoteRef.slice(0, 256))}`
				: target.ref
					? `the destination for ${JSON.stringify(target.ref.slice(0, 256))}`
					: "the destination for the current branch";
			const dir = target.dir ? ` in repository ${JSON.stringify(target.dir.slice(0, 256))}` : "";
			return `Remote outcome unknown. Verify ${destination} on ${remote}${dir} before retrying the push.`;
		},
	});

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
		push,
	};
}
