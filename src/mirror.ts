import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
	ConversationTranscript,
	type ConversationView,
	type EntryId,
	type EntryQuery,
	type TranscriptView,
} from "@earendil-works/pi-durable";
import { Data, Deferred, Effect, Option, type Duration } from "effect";
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

/** Send a message on the socket. */
export type PiSend = (message: PiClientMessage) => void;

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
	readonly #pageTimeout: Duration.Input;
	/** pi's view as the server last sent it; the operations apply to it. */
	#view: ConversationView | null = null;
	#projected: PiSessionView = EMPTY_VIEW;

	/** `onChange`: the projected view changed. */
	constructor(onChange: (view: PiSessionView) => void, pageTimeout: Duration.Input = PAGE_TIMEOUT) {
		this.#onChange = onChange;
		this.#pageTimeout = pageTimeout;
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
		const from = this.#transcript.resume?.from;
		send({ type: "watch", ...(from === undefined ? {} : { from }) });
	}

	/** The socket closed: pages it was loading will not arrive. */
	close(): void {
		this.#send = undefined;
		const pages = [...this.#pages.values()];
		this.#pages.clear();
		for (const page of pages) Effect.runSync(Deferred.fail(page, new HistoryDisconnected()));
	}

	/** Take one server message. */
	receive(message: PiServerMessage): void {
		switch (message.type) {
			case "view":
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
			const page = yield* Deferred.make<PiEntriesPage, Error>();
			yield* Effect.try({
				try: () => {
					if (this.#send === undefined) throw new HistoryDisconnected();
					this.#pages.set(id, page);
					this.#send({ type: "entries", id, query, limit });
				},
				catch: () => new HistoryDisconnected(),
			});
			return yield* Deferred.await(page);
		}).pipe(
			Effect.timeout(this.#pageTimeout),
			Effect.ensuring(Effect.sync(() => this.#pages.delete(id))),
		);
		return Effect.runPromise(request, { signal: context.abortSignal });
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
