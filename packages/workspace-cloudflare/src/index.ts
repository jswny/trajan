import { Workspace } from "@cloudflare/computer";
import { CodeModeError, codeModeError } from "@trajan/code-mode";
import type { CodeModeTool } from "@trajan/code-mode";
import { Effect, Schema } from "effect";
import { createWorkspaceGitClient, workspaceGit } from "./git";
import { workspaceFileTools } from "./file-changes";
import { workspaceLocks } from "./locks";
import type { FileMutationReceipt } from "./file-changes";

export { FileMutationReceipt } from "./file-changes";

const replaySafeFiles = new Set(["read", "ls", "find", "grep"]);
const atomicFiles = new Set(["write", "edit", "delete"]);
const isFileToolError = Schema.is(Schema.Struct({ isError: Schema.Literal(true) }));
const FileRead = Schema.Struct({
	path: Schema.NonEmptyString,
	content: Schema.String,
	truncated: Schema.Boolean,
});
const decodeFileRead = Schema.decodeUnknownOption(FileRead);

export function createCloudflareWorkspace(ctx: DurableObjectState, root: string) {
	const workspace = new Workspace({ storage: ctx.storage, git: createWorkspaceGitClient });
	void ctx.blockConcurrencyWhile(() =>
		Effect.runPromise(Effect.tryPromise(() => workspace.fs.mkdir(root, { recursive: true }))),
	);
	return workspace;
}

export function createWorkspaceTools(
	workspace: Workspace,
	{
		root,
		maxDiffBytes,
		describeRead,
	}: {
		readonly root: string;
		readonly maxDiffBytes: number;
		readonly describeRead?: (read: typeof FileRead.Type) => Schema.Json;
	},
) {
	const locks = workspaceLocks(root);
	const files = workspaceFileTools(workspace, root, maxDiffBytes);
	const fileTools = Object.fromEntries(
		files.tools.map(({ name, parameters, description }) => [
			name,
			{
				...(atomicFiles.has(name)
					? { replay: "atomic" as const, mutationLock: locks.fileMutation }
					: {
							replay: replaySafeFiles.has(name) ? ("safe" as const) : ("unsafe" as const),
							localStorage: true,
							lock: name === "read" ? locks.fileRead : locks.treeRead,
						}),
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
							const preview = describeRead?.({ path, content, truncated });
							if (preview !== undefined) {
								recordDetails(preview);
							}
						}
					}
					return { text, isError: result.isError, ...(details !== null && { details }) };
				}),
			} satisfies CodeModeTool,
		]),
	);
	return { files: fileTools, git: workspaceGit(workspace, root, locks) };
}
