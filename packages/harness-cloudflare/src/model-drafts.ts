import { InterruptedReply, TurnIoError } from "@trajan/harness";
import type { Streams, StreamStatus, StreamWriter } from "agents/streams";
import { Effect, Schema, Semaphore, Stream } from "effect";

const maxDraftLength = 8000;
const Attempt = Schema.Struct({
	checkpoint: Schema.NonEmptyString,
	attemptId: Schema.NonEmptyString,
});
const DraftChunk = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean });
const decodeAttempt = Schema.decodeUnknownSync(Attempt);
const decodeChunk = Schema.decodeUnknownEffect(DraftChunk);
const decodeInterrupted = Schema.decodeUnknownSync(
	Schema.UndefinedOr(Schema.Array(InterruptedReply)),
);
const interruptedKey = (runId: string) => `harness-draft:interrupted:${runId}`;
const draftTag = (runId: string) => `harness-draft:${runId}`;
const streamId = (runId: string, attemptId: string) => `${draftTag(runId)}:${attemptId}`;

export type DraftSettlement = (
	write: (drafts: ReadonlyArray<typeof InterruptedReply.Type>) => void,
) => void;

function streamError(operation: string, cause: unknown) {
	return new TurnIoError({ operation, cause });
}

export class ModelDrafts {
	readonly #updates = Semaphore.makeUnsafe(1);

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly streams: Streams,
		private readonly onInterrupted: (runId: string) => void,
	) {}

	readInterrupted(runId: string) {
		return decodeInterrupted(this.storage.kv.get(interruptedKey(runId))) ?? [];
	}

	readonly #pending = Effect.fnUntraced(function* (this: ModelDrafts, runId: string) {
		const [status] = yield* Effect.tryPromise({
			try: () => this.streams.list({ tag: draftTag(runId), state: "streaming", limit: 1 }),
			catch: (cause) => streamError("find model stream", cause),
		});
		return status;
	});

	readonly #read = Effect.fnUntraced(function* (this: ModelDrafts, status: StreamStatus) {
		const { attemptId } = decodeAttempt(status.metadata);
		const content = yield* Stream.fromAsyncIterable(this.streams.read(status.streamId), (cause) =>
			streamError("read model stream", cause),
		).pipe(
			Stream.take(status.cursor),
			Stream.mapEffect(({ chunk }) =>
				decodeChunk(chunk).pipe(
					Effect.mapError((cause) => streamError("decode model stream", cause)),
				),
			),
			Stream.runFold(
				() => ({ text: "", truncated: false }),
				(draft, chunk) => ({ text: draft.text + chunk.text, truncated: chunk.truncated }),
			),
		);
		return { role: "interrupted" as const, attemptId, ...content };
	});

	readonly read = Effect.fnUntraced(
		function* (this: ModelDrafts, runId: string) {
			const status = yield* this.#pending(runId);
			const draft = status && (yield* this.#read(status));
			return { text: draft?.text ?? "", interrupted: this.readInterrupted(runId) };
		},
		(effect) => this.#updates.withPermit(effect),
	);

	#open(id: string, runId: string, attempt?: typeof Attempt.Type) {
		return Effect.tryPromise({
			try: () =>
				this.streams.open(id, { tag: draftTag(runId), ...(attempt && { metadata: attempt }) }),
			catch: (cause) => streamError("open model stream", cause),
		});
	}

	readonly #archive = Effect.fnUntraced(function* (
		this: ModelDrafts,
		runId: string,
		status: StreamStatus,
	) {
		const draft = yield* this.#read(status);
		const writer = yield* this.#open(status.streamId, runId);
		const hasText = draft.text.trim().length > 0;
		yield* Effect.try({
			try: () =>
				writer.error("Interrupted", {
					discard: true,
					commit: () => {
						if (hasText) {
							this.storage.kv.put(interruptedKey(runId), [...this.readInterrupted(runId), draft]);
						}
					},
				}),
			catch: (cause) => streamError("archive model stream", cause),
		});
		return hasText;
	});

	interrupt(runId: string, checkpoint: string, attempt: number) {
		return this.#updates.withPermit(
			Effect.gen({ self: this }, function* () {
				const status = yield* this.#pending(runId);
				// An old attempt can finish unwinding after its replacement has started.
				if (
					status?.streamId === streamId(runId, `${checkpoint}:${attempt}`) &&
					(yield* this.#archive(runId, status))
				) {
					this.onInterrupted(runId);
				}
			}),
		);
	}

	capture<A, E, R>(
		runId: string,
		checkpoint: string,
		attempt: number,
		run: (recordText: (delta: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
	) {
		return Effect.gen({ self: this }, function* () {
			const attemptId = `${checkpoint}:${attempt}`;
			const writer = yield* this.#updates.withPermit(
				Effect.gen({ self: this }, function* () {
					const previous = yield* this.#pending(runId);
					if (previous) {
						yield* this.#archive(runId, previous);
					}
					return yield* this.#open(streamId(runId, attemptId), runId, { checkpoint, attemptId });
				}),
			);
			let length = 0;
			let truncated = false;
			return yield* run((delta) =>
				Effect.sync(() => {
					if (truncated || !delta) {
						return;
					}
					const remaining = maxDraftLength - length;
					truncated = delta.length > remaining;
					const text = truncated
						? delta.slice(0, remaining).replace(/[\uD800-\uDBFF]$/u, "")
						: delta;
					writer.append({ text, truncated });
					length += text.length;
				}),
			).pipe(
				Effect.onError(() =>
					this.interrupt(runId, checkpoint, attempt).pipe(
						Effect.catch((error) =>
							Effect.logWarning("Could not archive interrupted model stream", error),
						),
					),
				),
			);
		});
	}

	applyDecision(runId: string, checkpoint: string, write: () => void) {
		return this.#updates.withPermit(
			Effect.gen({ self: this }, function* () {
				const status = yield* this.#pending(runId);
				const writer =
					status && decodeAttempt(status.metadata).checkpoint === checkpoint
						? yield* this.#open(status.streamId, runId)
						: undefined;
				yield* Effect.try({
					try: () => this.#commit(writer, write),
					catch: (cause) => streamError("commit model decision", cause),
				});
			}),
		);
	}

	settle(runId: string, includeLive: boolean, settle: (transaction: DraftSettlement) => void) {
		return this.#updates.withPermit(
			Effect.gen({ self: this }, function* () {
				const status = yield* this.#pending(runId);
				const draft = includeLive && status ? yield* this.#read(status) : undefined;
				const writer = status && (yield* this.#open(status.streamId, runId));
				yield* Effect.try({
					try: () =>
						settle((write) =>
							this.#commit(writer, () => {
								const interrupted = this.readInterrupted(runId);
								this.storage.kv.delete(interruptedKey(runId));
								write(draft?.text.trim() ? [...interrupted, draft] : interrupted);
							}),
						),
					catch: (cause) => streamError("settle model stream", cause),
				});
			}),
		);
	}

	#commit(writer: StreamWriter | undefined, write: () => void) {
		if (writer) {
			writer.close({ commit: write, discard: true });
		} else {
			this.storage.transactionSync(write);
		}
	}
}
