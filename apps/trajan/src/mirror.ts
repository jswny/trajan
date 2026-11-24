import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { ConversationTranscript } from "@earendil-works/pi-durable";
import type {
	ConversationView,
	EntryId,
	EntryQuery,
	TranscriptView,
} from "@earendil-works/pi-durable";
import { Data, Deferred, Effect, Option } from "effect";
import { decodeEntriesPage, isConversationView } from "./protocol";
import type { PiClientMessage, PiEntriesPage, PiServerMessage } from "./protocol";
import { EMPTY_VIEW, projectView } from "./view";
import type { PiSessionView } from "./view";

/** Entries one "load earlier" or "load missing" asks the server for. */
const PAGE_SIZE = 50;
const PAGE_TIMEOUT = "15 seconds";
const HISTORY_REQUEST_PREFIX = "entries:";

export class HistoryDisconnected extends Data.TaggedError("HistoryDisconnected") {}
class InvalidTranscriptUpdate extends Data.TaggedError("InvalidTranscriptUpdate") {}

export function isHistoryRequest(id: string | undefined): boolean {
	return id?.startsWith(HISTORY_REQUEST_PREFIX) ?? false;
}

/** Whether the message was sent on the socket. */
type PiSend = (message: PiClientMessage) => boolean;

/**
 * The client's copy of one session, over this app's socket protocol: pi's
 * conversation view, kept current from the server's `view` and `ops`
 * frames, merged into a `ConversationTranscript` that keeps every entry
 * the client has seen, beyond the view's window. Earlier entries, and
 * entries a stall or reconnect skipped, load on demand with `entries`
 * requests. Pure state, no React, so the browser hook and the tests run
 * the same code.
 */
export class PiSessionMirror {
	/** The open socket's send, between `open()` and `close()`. */
	#send: PiSend | undefined;
	readonly #transcript: ConversationTranscript;
	readonly #pages = new Map<string, Deferred.Deferred<PiEntriesPage, Error>>();
	readonly #runPage: typeof Effect.runPromise;
	/** pi's view as the server last sent it; the operations apply to it. */
	#view: ConversationView | null = null;
	#projected: PiSessionView = EMPTY_VIEW;

	constructor(runPage = Effect.runPromise) {
		this.#runPage = runPage;
		this.#transcript = new ConversationTranscript(
			(query, limit, context) => this.#loadPage(query, limit, context),
			{ pageSize: PAGE_SIZE },
		);
	}

	get view(): PiSessionView {
		return this.#projected;
	}

	/**
	 * A socket opened: ask to watch the session, after the newest entry the
	 * transcript has, so a reconnect gets only what it missed.
	 */
	open(send: PiSend): void {
		this.#send = send;
		// Keep the transcript, but wait for this watch's snapshot before applying its patches.
		this.#view = null;
		const from = this.#transcript.resume?.from;
		send({ type: "watch", ...(from !== undefined && { from }) });
	}

	/** The socket closed: pages it was loading will not arrive. */
	close(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			this.#send = undefined;
			this.#view = null;
			const pages = [...this.#pages.values()];
			this.#pages.clear();
			for (const page of pages) {
				yield* Deferred.fail(page, new HistoryDisconnected());
			}
		});
	}

	/** Take one server message. */
	receive(
		message: PiServerMessage,
	): Effect.Effect<PiSessionView | undefined, InvalidTranscriptUpdate> {
		return Effect.gen({ self: this }, function* () {
			if (message.type === "result" || message.type === "error") {
				yield* this.#settlePage(message);
				return;
			}
			return yield* Effect.try({
				try: () => {
					if (message.type === "view" && this.#send !== undefined) {
						return this.#merge(message.view);
					}
					if (message.type !== "ops" || this.#view === null) {
						return;
					}
					const next = applyImmutable(this.#view, message.ops);
					if (!isConversationView(next)) {
						throw new InvalidTranscriptUpdate();
					}
					return this.#merge(next);
				},
				catch: () => new InvalidTranscriptUpdate(),
			});
		});
	}

	/** Load the page before the oldest message shown. */
	loadEarlier() {
		return Effect.suspend(() =>
			this.#projected.earlier
				? this.#load((context) => this.#transcript.loadEarlier(context))
				: Effect.succeed(undefined),
		);
	}

	/** Load the next page of a gap, a `gap` message of the view. */
	fillGap(gap: { after: EntryId; upTo: EntryId }) {
		return this.#load((context) => this.#transcript.fillGap({ kind: "gap", ...gap }, context));
	}

	#load(request: (context: Context) => Promise<TranscriptView>) {
		return Effect.tryPromise({
			try: (signal) => request(withAbortSignal(signal, BACKGROUND_CONTEXT)),
			catch: (error) => error,
		}).pipe(
			Effect.flatMap((view) =>
				Effect.try({ try: () => this.#show(view), catch: (error) => error }),
			),
		);
	}

	#merge(view: ConversationView): PiSessionView {
		const projected = this.#show(this.#transcript.merge(view));
		this.#view = view;
		return projected;
	}

	#show(view: TranscriptView): PiSessionView {
		this.#projected = projectView(view);
		return this.#projected;
	}

	#loadPage(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		context: Context,
	): Promise<PiEntriesPage> {
		const id = `${HISTORY_REQUEST_PREFIX}${crypto.randomUUID()}`;
		const request = Effect.gen({ self: this }, function* () {
			const send = this.#send;
			if (send === undefined) {
				return yield* new HistoryDisconnected();
			}
			const page = yield* Deferred.make<PiEntriesPage, Error>();
			this.#pages.set(id, page);
			if (!send({ type: "entries", id, query, limit })) {
				return yield* Effect.fail(new Error("Could not request messages. Try again."));
			}
			return yield* Deferred.await(page);
		}).pipe(
			Effect.timeout(PAGE_TIMEOUT),
			Effect.ensuring(Effect.sync(() => this.#pages.delete(id))),
		);
		return this.#runPage(request, { signal: context.abortSignal });
	}

	#settlePage(
		message: Extract<PiServerMessage, { type: "result" | "error" }>,
	): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (message.id === undefined) {
				return;
			}
			const page = this.#pages.get(message.id);
			if (page === undefined) {
				return;
			}
			if (message.type === "error") {
				yield* Deferred.fail(page, new Error(message.message));
				return;
			}
			const decoded = decodeEntriesPage(message.result);
			if (Option.isSome(decoded)) {
				yield* Deferred.succeed(page, decoded.value);
			} else {
				yield* Deferred.fail(page, new Error("Invalid history page"));
			}
		});
	}
}
