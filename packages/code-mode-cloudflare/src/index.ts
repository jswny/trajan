import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import {
	codeModeError,
	createCodeMode,
	decodeCallCheckpoint,
	decodeReplayCheckpoint,
	decodeRunCheckpoint,
} from "@trajan/code-mode";
import type { CodeModeCatalog, CodeModeJournal } from "@trajan/code-mode";
import { Effect } from "effect";
import { quickJsGuest } from "./guest";

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
	// Standalone journal writes must have their own transaction so another call's rollback cannot undo them.
	const persist = (write: () => void, runSignal?: AbortSignal) =>
		Effect.tryPromise({
			try: async (signal) => {
				await storage.transaction(async () => {
					signal.throwIfAborted();
					runSignal?.throwIfAborted();
					write();
				});
				await storage.sync();
			},
			catch: codeModeError,
		});
	return {
		callId,
		readRun: () => decodeRunCheckpoint(storage.kv.get(key)),
		readCall: (index) => decodeCallCheckpoint(storage.kv.get(callId(index))),
		readReplay: () => decodeReplayCheckpoint(storage.kv.get(`${key}:replay`)),
		start: (checkpoint) => persist(() => storage.kv.put(key, checkpoint)),
		recordCall: (index, checkpoint, signal) =>
			persist(() => storage.kv.put(callId(index), checkpoint), signal),
		recordReplay: (checkpoint) => persist(() => storage.kv.put(`${key}:replay`, checkpoint)),
		finish: (checkpoint) => persist(() => storage.kv.put(key, checkpoint)),
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
				catch: codeModeError,
			});
		}),
	};
}

export type CodeModeSandboxBinding = DurableObjectNamespace<CodemodeSandboxDurableObject>;

export function createCloudflareCodeMode(
	sandbox: CodeModeSandboxBinding,
	storage: DurableObjectStorage,
	catalog: CodeModeCatalog,
) {
	return createCodeMode(
		{
			openJournal: (scope, executionId) => openJournal(storage, scope, executionId),
			isolateStorage: (effect) =>
				Effect.gen(function* () {
					const run = Effect.runPromiseWith(yield* Effect.context<never>());
					const result = yield* Effect.tryPromise({
						try: (signal) => storage.transaction(() => run(Effect.result(effect), { signal })),
						catch: codeModeError,
					});
					return yield* Effect.fromResult(result);
				}),
			prepareGuest: quickJsGuest((executionId) => sandbox.getByName(executionId)),
		},
		catalog,
	);
}
