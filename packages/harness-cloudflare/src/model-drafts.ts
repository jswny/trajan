import { InterruptedReply, publishUpdate } from "@trajan/harness";
import { Effect, Schema } from "effect";

const maxDraftLength = 8000;
const LiveDraft = Schema.Struct({
	checkpoint: Schema.NonEmptyString,
	attemptId: Schema.NonEmptyString,
	text: Schema.String,
	truncated: Schema.Boolean,
});
const decodeDraft = Schema.decodeUnknownSync(Schema.UndefinedOr(LiveDraft));
const decodeInterrupted = Schema.decodeUnknownSync(
	Schema.UndefinedOr(Schema.Array(InterruptedReply)),
);
const liveKey = (runId: string) => `harness-draft:live:${runId}`;
const interruptedKey = (runId: string) => `harness-draft:interrupted:${runId}`;

function interruptedReply(draft: typeof LiveDraft.Type): typeof InterruptedReply.Type {
	return {
		role: "interrupted",
		attemptId: draft.attemptId,
		text: draft.text,
		truncated: draft.truncated,
	};
}

export class ModelDrafts {
	constructor(private readonly storage: DurableObjectStorage) {}

	read(runId: string) {
		return {
			text: decodeDraft(this.storage.kv.get(liveKey(runId)))?.text ?? "",
			interrupted: decodeInterrupted(this.storage.kv.get(interruptedKey(runId))) ?? [],
		};
	}

	capture<A, E, R>(
		runId: string,
		checkpoint: string,
		attempt: number,
		run: (recordText: (delta: string) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
	) {
		return Effect.gen({ self: this }, function* () {
			const key = liveKey(runId);
			const attemptId = `${checkpoint}:${attempt}`;
			const kv = this.storage.kv;
			this.storage.transactionSync(() => {
				const previous = decodeDraft(kv.get(key));
				if (previous?.checkpoint === checkpoint && previous.text.trim()) {
					const archived = interruptedKey(runId);
					kv.put(archived, [
						...(decodeInterrupted(kv.get(archived)) ?? []),
						interruptedReply(previous),
					]);
				}
				kv.put(key, { checkpoint, attemptId, text: "", truncated: false });
			});

			let text = "";
			let truncated = false;
			let savedText = "";
			let savedTruncated = false;
			const flush = publishUpdate("model draft", () =>
				Effect.sync(() => {
					if (text === savedText && truncated === savedTruncated) {
						return;
					}
					// A timed-out attempt can finish unwinding after its replacement has started.
					if (decodeDraft(kv.get(key))?.attemptId === attemptId) {
						kv.put(key, { checkpoint, attemptId, text, truncated });
						savedText = text;
						savedTruncated = truncated;
					}
				}),
			);
			yield* Effect.sleep("1 second").pipe(
				Effect.andThen(flush),
				Effect.forever,
				Effect.forkScoped,
			);
			return yield* run((delta) =>
				Effect.suspend(() => {
					if (truncated || !delta) {
						return Effect.void;
					}
					const first = text.length === 0;
					const next = text + delta;
					truncated = next.length > maxDraftLength;
					text = truncated ? next.slice(0, maxDraftLength).replace(/[\uD800-\uDBFF]$/u, "") : next;
					return first ? flush : Effect.void;
				}),
			).pipe(Effect.ensuring(flush));
		}).pipe(Effect.scoped);
	}

	clearCheckpoint(runId: string, checkpoint: string) {
		const key = liveKey(runId);
		if (decodeDraft(this.storage.kv.get(key))?.checkpoint === checkpoint) {
			this.storage.kv.delete(key);
		}
	}

	/** Called inside the transaction that writes the final transcript or failure. */
	settle(runId: string, includeLive: boolean) {
		const live = liveKey(runId);
		const archived = interruptedKey(runId);
		const draft = includeLive ? decodeDraft(this.storage.kv.get(live)) : undefined;
		const replies = decodeInterrupted(this.storage.kv.get(archived)) ?? [];
		this.storage.kv.delete(live);
		this.storage.kv.delete(archived);
		return draft?.text.trim() ? [...replies, interruptedReply(draft)] : replies;
	}
}
