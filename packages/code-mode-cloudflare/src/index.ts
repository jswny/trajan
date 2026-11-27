import { RpcTarget } from "cloudflare:workers";
import {
	CodeModeError,
	createCodeMode,
	decodeCallCheckpoint,
	decodeRunCheckpoint,
} from "@trajan/code-mode";
import type { CodeModeCatalog, CodeModeJournal, ToolReply } from "@trajan/code-mode";
import { Effect } from "effect";
import { loadGuest } from "./guest";

const storageError = (cause: unknown) =>
	new CodeModeError({ message: cause instanceof Error ? cause.message : String(cause) });

function runPrefix(scope: string) {
	return `code-mode:${encodeURIComponent(scope)}:`;
}

export function clearCodeModeRun(storage: DurableObjectStorage, scope: string) {
	for (const [key] of Array.from(storage.kv.list({ prefix: runPrefix(scope) }))) {
		storage.kv.delete(key);
	}
}

function openJournal(storage: DurableObjectStorage, scope: string, id: string): CodeModeJournal {
	const key = `${runPrefix(scope)}${encodeURIComponent(id)}`;
	const callId = (index: number) => `${key}:call:${index}`;
	return {
		callId,
		readRun: () => decodeRunCheckpoint(storage.kv.get(key)),
		readCall: (index) => decodeCallCheckpoint(storage.kv.get(callId(index))),
		start: (source) => storage.kv.put(key, { source }),
		recordCall: (index, checkpoint) =>
			Effect.tryPromise({
				try: () => {
					storage.kv.put(callId(index), checkpoint);
					return storage.sync();
				},
				catch: storageError,
			}),
		finish: (checkpoint) =>
			Effect.tryPromise({
				try: () => {
					storage.kv.put(key, checkpoint);
					return storage.sync();
				},
				catch: storageError,
			}),
		commitCall: Effect.fnUntraced(function* (index, signal, invoke, receipt) {
			const context = yield* Effect.context<never>();
			return yield* Effect.tryPromise({
				try: async () => {
					const outcome = await storage.transaction(async (txn) => {
						signal.throwIfAborted();
						const reply = await Effect.runPromiseWith(context)(invoke);
						const committed = receipt(reply);
						if (!committed) {
							txn.rollback();
							return { reply };
						}
						// SQLite-backed Durable Objects include direct storage calls in the transaction.
						storage.kv.put(callId(index), committed);
						return { reply, committed };
					});
					if (outcome.committed) {
						await storage.sync();
					}
					return outcome;
				},
				catch: storageError,
			});
		}),
	};
}

class HostTools extends RpcTarget {
	readonly #call: (call: unknown) => Promise<ToolReply>;

	constructor(call: (call: unknown) => Promise<ToolReply>) {
		super();
		this.#call = call;
	}

	call(call: unknown) {
		return this.#call(call);
	}
}

export function createCloudflareCodeMode(
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	catalog: CodeModeCatalog,
) {
	return createCodeMode(
		{
			openJournal: (scope, executionId) => openJournal(storage, scope, executionId),
			runGuest: (source, namespaces, call) =>
				loadGuest<HostTools>(loader, source, namespaces).run(new HostTools(call)),
		},
		catalog,
	);
}
