import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import type { Workspace } from "@cloudflare/computer";
import type { PiToolCall, ToolCallContext } from "@cloudflare/computer/tools/pi-ai";
import type { FileChange } from "./chat/tool-presentation";
import { fileDiffBytes } from "./chat/tool-presentation";
import { formatPatch, structuredPatch } from "diff";
import { Effect, Predicate, Schema } from "effect";

export const FileMutationReceipt = Schema.Union([
	Schema.Struct({
		isError: Schema.Literal(false),
		text: Schema.String,
		details: Schema.Struct({ path: Schema.NonEmptyString, bytesWritten: Schema.Int }),
	}),
	Schema.Struct({ isError: Schema.Literal(true), text: Schema.String }),
]);

const snapshotBytes = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeText(bytes: Uint8Array) {
	if (bytes.byteLength <= snapshotBytes && !bytes.includes(0)) {
		try {
			return decoder.decode(bytes);
		} catch {
			// Content that cannot be decoded as UTF-8 has no text preview.
		}
	}
}

async function snapshot(fs: Workspace["fs"], path: string) {
	try {
		const stat = await fs.stat(path);
		const text =
			stat.isFile && stat.size <= snapshotBytes
				? decodeText(
						new Uint8Array(
							await new Response(
								await fs.readFile(path, { byteLength: snapshotBytes + 1 }),
							).arrayBuffer(),
						),
					)
				: undefined;
		return { exists: true, text };
	} catch (error) {
		if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") {
			return { exists: false, text: "" };
		}
		// Preview IO may fail independently of the mutation.
		return undefined;
	}
}

function describeChange(
	path: string,
	before: Awaited<ReturnType<typeof snapshot>>,
	bytes: Uint8Array,
): typeof FileChange.Type | undefined {
	if (!before) {
		return undefined;
	}
	const after = decodeText(bytes);
	const kind = !before.exists
		? "added"
		: before.text !== undefined && before.text === after
			? "unchanged"
			: "modified";
	const change = { path, kind } as const;
	if (before.text === undefined || after === undefined || before.text === after) {
		return change;
	}
	const name = path.slice(1);
	try {
		const patch = structuredPatch(
			`a/${name}`,
			`b/${name}`,
			before.text,
			after,
			undefined,
			undefined,
			{ context: 3, timeout: 30 },
		);
		const diff = patch && formatPatch({ ...patch, isGit: true, isCreate: !before.exists });
		return diff && encoder.encode(diff).byteLength <= fileDiffBytes ? { ...change, diff } : change;
	} catch {
		return change;
	}
}

type ObservedWrite = {
	readonly path: string;
	readonly bytesWritten: number;
	readonly change?: typeof FileChange.Type;
};

export function workspaceFileTools(workspace: Workspace, root: string) {
	const fs = workspace.fs;
	let observeWrite: ((write: ObservedWrite) => void) | undefined;
	// Computer still validates arguments, confines paths, and applies the write or edit.
	// The filesystem adapter observes the exact path and bytes within the same mutation.
	const adapter: Parameters<typeof createPiTools>[0]["workspace"]["fs"] &
		Pick<Workspace["fs"], "lstat"> = {
		stat: fs.stat.bind(fs),
		lstat: fs.lstat.bind(fs),
		readFile: (path, options) => fs.readFile(path, options ?? {}),
		mkdir: fs.mkdir.bind(fs),
		rm: fs.rm.bind(fs),
		find: fs.find.bind(fs),
		grep: fs.grep.bind(fs),
		readdir: fs.readdir.bind(fs),
		async writeFile(path, bytes, options) {
			const observe = observeWrite;
			const before = observe && (await snapshot(fs, path));
			await fs.writeFile(path, bytes, options);
			if (observe) {
				const change = describeChange(path, before, bytes);
				observe({ path, bytesWritten: bytes.byteLength, ...(change && { change }) });
			}
		},
	};
	const files = createPiTools({
		workspace: {
			fs: adapter,
			runtime: workspace.runtime,
			sessionId: workspace.sessionId,
			...(workspace.assets && { assets: workspace.assets }),
		},
		root,
		exec: { backends: {} },
	});

	function execute(call: PiToolCall, context: ToolCallContext) {
		const tracksWrite = call.name === "write" || call.name === "edit";
		return Effect.tryPromise(async () => {
			context.abortSignal?.throwIfAborted();
			let observed: ObservedWrite | undefined;
			if (tracksWrite) {
				observeWrite = (write) => {
					observed = write;
				};
			}
			try {
				const result = await files.execute(call, context);
				return { result, observed };
			} finally {
				if (tracksWrite) {
					observeWrite = undefined;
				}
			}
		});
	}

	return { tools: files.tools, execute };
}
