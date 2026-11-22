import type {
	ConversationView,
	ConversationWatch,
	ConversationWindow,
	EntryId,
	RegistryReader,
	WatchEnd,
} from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import { ROOT_SESSION, type PiHarness, type PiSessionId } from "agents/harness/pi";
import { Result } from "effect";
import {
	decodeClientMessage,
	decodeRequestId,
	type PiClientMessage,
	type PiCommandResult,
	type PiServerMessage,
} from "./protocol";

const SESSION_TAG_PREFIX = "pi-session:";
const SESSION_QUERY = "session";
/** The most entries one `entries` request returns. */
const MAX_PAGE = 100;
/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

function sessionTag(session: PiSessionId): string {
	return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(request: Request, fallback: PiSessionId): string {
	const session = new URL(request.url).searchParams.get(SESSION_QUERY);
	if (session === null || session === "") return fallback;
	if (!/^[1-9][0-9]{0,15}$/.test(session)) {
		throw new Error(`Invalid pi session ${JSON.stringify(session)}`);
	}
	return session;
}

function sessionOf(tags: readonly string[]): string | undefined {
	const tag = tags.find((candidate) => candidate.startsWith(SESSION_TAG_PREFIX));
	return tag?.slice(SESSION_TAG_PREFIX.length);
}

/**
 * The window that continues what a watch last sent: right after its newest
 * entry, as `ConversationTranscript.resume` is for the client.
 */
function resumeAfter(view: ConversationView): ConversationWindow {
	const newest = view.entries.at(-1)?.id ?? view.before;
	return newest === undefined ? {} : { from: (newest + 1) as EntryId };
}

function send(socket: WebSocket, message: PiServerMessage): void {
	if (socket.readyState !== OPEN) return;
	try {
		socket.send(JSON.stringify(message));
	} catch {
		// The socket closed between the state check and the send.
	}
}

/**
 * App glue: this app's session protocol over the `WebSockets` capability,
 * built only on the harness's public API.
 *
 * Each socket follows one session, picked by `?session=`. The client asks
 * to `watch` it each time the socket opens, and gets its own
 * `session.watch()`: the view, then pi's operations for each change. The
 * view's window holds only the newest entries (pi's default, 50 to 100);
 * the client keeps the rest in a `ConversationTranscript`, which pages
 * earlier entries with `entries` requests (`session.entries()`) and resumes
 * after a reconnect from the newest entry it has. Commands on the socket
 * call `session.submit()`, `abort()`, and `reset()`.
 *
 * Watches live in memory, so the host calls `reattach()` from its `onStart`
 * to give sockets that outlived the last isolate a new watch. A watch also
 * ends when pi closes, as the harness does to reopen a pi that failed; the
 * socket then gets a new watch that continues where the last one stopped.
 */
export class PiSessionSockets {
	readonly #harness: PiHarness;
	readonly #registry: RegistryReader;
	readonly #getWebSockets: (tag?: string) => WebSocket[];
	readonly #watches = new Map<WebSocket, ConversationWatch>();
	#closed = false;

	constructor(
		harness: PiHarness,
		/** The registry pi was opened with, for the tool list sent on connect. */
		registry: RegistryReader,
		getWebSockets: (tag?: string) => WebSocket[],
	) {
		this.#harness = harness;
		this.#registry = registry;
		this.#getWebSockets = getWebSockets;
	}

	options(): WebSocketsOptions {
		return {
			getConnectionTags: (_connection, ctx) => [
				sessionTag(sessionFromRequest(ctx.request, ROOT_SESSION)),
			],
			handlers: {
				onConnect: (connection, ctx) => this.#onConnect(connection, ctx),
				onMessage: (connection, message) => this.#onMessage(connection, message),
				onClose: (connection) => this.#unwatch(connection),
				onError: (connection) => this.#unwatch(connection),
			},
		};
	}

	/** Give every hibernated socket a new watch after the object restarts. */
	async reattach(): Promise<void> {
		if (this.#getWebSockets().length === 0) return;
		// Sockets are found by tag, not tags by socket, so walk the sessions
		// and look up each one's tag.
		for (const { id } of await this.#harness.sessions.list()) {
			for (const socket of this.#getWebSockets(sessionTag(id))) {
				await this.#watchOrClose(socket, id);
			}
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		const watches = [...this.#watches.values()];
		this.#watches.clear();
		await Promise.all(watches.map((watch) => watch.stop()));
	}

	async #onConnect(connection: Connection, ctx: ConnectionContext) {
		const session = sessionFromRequest(ctx.request, ROOT_SESSION);
		send(connection, {
			type: "hello",
			session,
			tools: this.#registry
				.snapshot()
				.tools()
				.map(({ tool }) => ({ name: tool.name, description: tool.description })),
		});
		// The client sends `watch` next, with where its transcript ends.
	}

	/**
	 * Give `socket` a new watch of `session`, ending the one it had: send the
	 * view, then pi's operations for each change.
	 */
	async #watch(
		socket: WebSocket,
		session: PiSessionId,
		window: ConversationWindow = {},
	): Promise<void> {
		const watch = await this.#harness.session(session).watch(window);
		if (this.#closed || socket.readyState !== OPEN) {
			await watch.stop();
			return;
		}
		// Stop the last watch before this one sends anything, so the client
		// never gets its operations after this view. Two `#watch` calls for one
		// socket can overlap, as `reattach()` and a client's `watch` do.
		const previous = this.#watches.get(socket);
		this.#watches.set(socket, watch);
		void previous?.stop();
		let last = watch.value;
		send(socket, { type: "view", session, view: last });
		watch.start(async (call) => {
			// Pi ends a watch on failure instead of sending a `failed` call.
			if (call.kind !== "value") return;
			if (socket.readyState !== OPEN) {
				void this.#unwatch(socket);
				return;
			}
			last = call.value;
			send(socket, { type: "ops", session, ops: call.ops });
		});
		void watch.closed.then((end) => this.#ended(socket, session, watch, end, last));
	}

	/**
	 * A watch ended. Unless this class stopped it, pi closed (`ended`) or
	 * failed (`failed`), or the listener threw: watch again, from right after
	 * the last entry the socket got. Opening the session reopens pi.
	 */
	async #ended(
		socket: WebSocket,
		session: PiSessionId,
		watch: ConversationWatch,
		end: WatchEnd,
		last: ConversationView,
	): Promise<void> {
		if (end.kind === "stopped" || end.kind === "aborted") return;
		if (this.#watches.get(socket) !== watch) return;
		this.#watches.delete(socket);
		if (this.#closed || socket.readyState !== OPEN) return;
		await this.#watchOrClose(socket, session, resumeAfter(last));
	}

	/**
	 * `#watch`, or, when pi does not open, close the socket with 1011. The
	 * client reconnects, backing off, and its `watch` tries again. A socket
	 * left open without a watch would never see the session change.
	 */
	async #watchOrClose(
		socket: WebSocket,
		session: PiSessionId,
		window: ConversationWindow = {},
	): Promise<void> {
		try {
			await this.#watch(socket, session, window);
		} catch (error) {
			console.warn("pi session watch lost", error);
			try {
				socket.close(1011, "Lost the session's watch");
			} catch {
				// Already closed.
			}
		}
	}

	async #unwatch(socket: WebSocket): Promise<void> {
		const watch = this.#watches.get(socket);
		if (!watch) return;
		this.#watches.delete(socket);
		await watch.stop();
	}

	async #onMessage(connection: Connection, raw: WebSocketMessage) {
		if (typeof raw !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			send(connection, { type: "error", message: "Malformed JSON" });
			return;
		}
		const decoded = decodeClientMessage(parsed);
		if (Result.isFailure(decoded)) {
			const request = decodeRequestId(parsed);
			const id = Result.isSuccess(request) ? request.success.id : undefined;
			send(connection, {
				type: "error",
				...(id === undefined ? {} : { id }),
				message: "Invalid session message",
			});
			return;
		}
		const message = decoded.success;
		const session = sessionOf(connection.tags) ?? ROOT_SESSION;
		try {
			const result = await this.#dispatch(connection, session, message);
			if (message.id !== undefined) {
				send(connection, { type: "result", id: message.id, result });
			}
		} catch (error) {
			send(connection, {
				type: "error",
				...(message.id === undefined ? {} : { id: message.id }),
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #dispatch(
		connection: Connection,
		session: PiSessionId,
		message: PiClientMessage,
	): Promise<PiCommandResult> {
		const handle = this.#harness.session(session);
		switch (message.type) {
			case "submit":
				return await handle.submit(message.input, {
					...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
					...(message.operationId ? { operationId: message.operationId } : {}),
				});
			case "abort":
				return await handle.abort();
			case "reset":
				await handle.reset(message.handoff);
				return null;
			case "watch":
				await this.#watchOrClose(
					connection,
					session,
					message.from === undefined ? {} : { from: message.from },
				);
				return null;
			case "entries":
				return await handle.entries(message.query ?? {}, Math.min(message.limit, MAX_PAGE));
		}
	}
}
