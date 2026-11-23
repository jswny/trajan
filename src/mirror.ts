import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
	ConversationTranscript,
	type ConversationView,
	type EntryId,
	type EntryQuery,
	type TranscriptView,
} from "@earendil-works/pi-durable";
import { Data, Deferred, Effect, Option } from "effect";
import {
	decodeEntriesPage,
	type PiClientMessage,
	type PiEntriesPage,
	type PiServerMessage,
} from "./protocol";
import { EMPTY_VIEW, projectView, type PiSessionView } from "./view";

/** Entries one "load earlier" or "load missing" asks the server for. */
const PAGE_SIZE = 50;
const PAGE_TIMEOUT = "15 seconds";
const HISTORY_REQUEST_PREFIX = "entries:";

export class HistoryDisconnected extends Data.TaggedError("HistoryDisconnected") {}

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
	readonly #onChange: (view: PiSessionView) => void;
	/** The open socket's send, between `open()` and `close()`. */
	#send: PiSend | undefined;
	readonly #transcript: ConversationTranscript;
	readonly #pages = new Map<string, Deferred.Deferred<PiEntriesPage, Error>>();
	readonly #runPage: typeof Effect.runPromise;
	/** pi's view as the server last sent it; the operations apply to it. */
	#view: ConversationView | null = null;
	#projected: PiSessionView = EMPTY_VIEW;

	constructor(onChange: (view: PiSessionView) => void, runPage = Effect.runPromise) {
		this.#onChange = onChange;
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
		send({ type: "watch", ...(from === undefined ? {} : { from }) });
	}

	/** The socket closed: pages it was loading will not arrive. */
	close(): void {
		this.#send = undefined;
		this.#view = null;
		const pages = [...this.#pages.values()];
		this.#pages.clear();
		for (const page of pages) Effect.runSync(Deferred.fail(page, new HistoryDisconnected()));
	}

	/** Take one server message. */
	receive(message: PiServerMessage): void {
		switch (message.type) {
			case "view":
				if (this.#send === undefined) return;
				this.#view = message.view;
				this.#show(this.#transcript.merge(this.#view));
				return;
			case "ops":
				// Operations without a view to apply to: wait for the next view.
				if (this.#view === null) return;
				this.#view = applyImmutable(this.#view, message.ops);
				this.#show(this.#transcript.merge(this.#view));
				return;
			case "result":
			case "error":
				this.#settlePage(message);
				return;
			default:
				return;
		}
	}

	/** Load the page before the oldest message shown. */
	async loadEarlier(context = BACKGROUND_CONTEXT): Promise<void> {
		if (!this.#projected.earlier) return;
		const view = await this.#transcript.loadEarlier(context);
		if (!context.abortSignal?.aborted) this.#show(view);
	}

	/** Load the next page of a gap, a `gap` message of the view. */
	async fillGap(
		gap: { after: EntryId; upTo: EntryId },
		context = BACKGROUND_CONTEXT,
	): Promise<void> {
		const view = await this.#transcript.fillGap(
			{ kind: "gap", after: gap.after, upTo: gap.upTo },
			context,
		);
		if (!context.abortSignal?.aborted) this.#show(view);
	}

	#show(view: TranscriptView): void {
		const projected = projectView(view);
		this.#projected = projected;
		this.#onChange(projected);
	}

	#loadPage(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		context: Context,
	): Promise<PiEntriesPage> {
		const id = `${HISTORY_REQUEST_PREFIX}${crypto.randomUUID()}`;
		const request = Effect.gen({ self: this }, function* () {
			const send = this.#send;
			if (send === undefined) return yield* new HistoryDisconnected();
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

	#settlePage(message: Extract<PiServerMessage, { type: "result" | "error" }>): void {
		if (message.id === undefined) return;
		const page = this.#pages.get(message.id);
		if (page === undefined) return;
		if (message.type === "error") {
			Effect.runSync(Deferred.fail(page, new Error(message.message)));
			return;
		}
		const decoded = decodeEntriesPage(message.result);
		Effect.runSync(
			Option.isSome(decoded)
				? Deferred.succeed(page, decoded.value)
				: Deferred.fail(page, new Error("Invalid history page")),
		);
	}
}
