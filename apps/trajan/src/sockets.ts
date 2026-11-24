import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type {
	ConversationView,
	ConversationWindow,
	EntryId,
	RegistryReader,
	WatchEnd,
} from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext } from "agents/lifecycle";
import type { WebSocketMessage, WebSocketsOptions } from "agents/websockets";
import { ROOT_SESSION, type PiHarness, type PiSessionId } from "agents/harness/pi";
import { Effect, Exit, Logger, Result, Schema, Scope } from "effect";
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
const watchLogger = Logger.layer([Logger.withLeveledConsole(Logger.formatStructured)]);
const parseFrame = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodePiSessionId = Schema.decodeUnknownResult(
	Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,15}$/)).pipe(
		Schema.decodeTo(Schema.NumberFromString.check(Schema.isInt())),
	),
);

function callPi<A>(run: () => Promise<A>) {
	return Effect.tryPromise({ try: run, catch: (error) => error });
}

type WatchTrigger =
	| { readonly trigger: "client_request" | "hibernation_reattach" }
	| {
			readonly trigger: "recovery";
			readonly previousEnd: Exclude<WatchEnd["kind"], "stopped" | "aborted">;
	  };
type WatchOutcome = "started" | "cancelled" | "failed";

function watchLog(
	event: "pi_session_watch" | "pi_session_watch_cleanup",
	outcome: WatchOutcome,
	startedAt: number,
	annotations: Record<string, string | boolean> = {},
) {
	const log = outcome === "failed" ? Effect.logWarning : Effect.logInfo;
	return log(event).pipe(
		Effect.annotateLogs({
			...annotations,
			outcome,
			elapsedMs: Math.round(performance.now() - startedAt),
		}),
		Effect.provide(watchLogger),
		Effect.ignoreCause,
	);
}

function watchReporter(trigger: WatchTrigger, replaced: boolean) {
	const startedAt = performance.now();
	// The scope finalizer reports cancellation only if setup had no outcome yet.
	let reported = false;
	return (outcome: WatchOutcome) =>
		Effect.suspend(() => {
			if (reported) return Effect.void;
			reported = true;
			return watchLog("pi_session_watch", outcome, startedAt, { ...trigger, replaced });
		});
}

function sessionTag(session: PiSessionId): string {
	return `${SESSION_TAG_PREFIX}${session}`;
}

function sessionFromRequest(request: Request, fallback: PiSessionId): string {
	const session = new URL(request.url).searchParams.get(SESSION_QUERY);
	if (session === null || session === "") return fallback;
	if (Result.isFailure(decodePiSessionId(session))) {
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

function send(socket: WebSocket, message: PiServerMessage): boolean {
	if (socket.readyState !== OPEN) return false;
	try {
		socket.send(JSON.stringify(message));
		return true;
	} catch {
		return false;
	}
}

const closeWatchScope = Effect.fnUntraced(function* (scope: Scope.Closeable) {
	const startedAt = performance.now();
	yield* Scope.close(scope, Exit.void).pipe(
		Effect.catchCause(() => watchLog("pi_session_watch_cleanup", "failed", startedAt)),
	);
});

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
	readonly #watchScopes = new Map<WebSocket, Scope.Closeable>();
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
				onMessage: (connection, message) => Effect.runPromise(this.#onMessage(connection, message)),
				onClose: (connection) => Effect.runPromise(this.#unwatch(connection)),
				onError: (connection) => Effect.runPromise(this.#unwatch(connection)),
			},
		};
	}

	/** Give every hibernated socket a new watch after the object restarts. */
	reattach(): Promise<void> {
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				if (this.#getWebSockets().length === 0) return;
				// Look up the sockets by each session's tag.
				const sessions = yield* callPi(() => this.#harness.sessions.list());
				for (const { id } of sessions) {
					for (const socket of this.#getWebSockets(sessionTag(id))) {
						if (!this.#watchScopes.has(socket)) {
							yield* this.#watchOrClose(socket, id, { trigger: "hibernation_reattach" });
						}
					}
				}
			}),
		);
	}

	close(): Promise<void> {
		return Effect.runPromise(
			Effect.gen({ self: this }, function* () {
				this.#closed = true;
				const scopes = [...this.#watchScopes.values()];
				this.#watchScopes.clear();
				yield* Effect.forEach(scopes, closeWatchScope, { concurrency: "unbounded", discard: true });
			}),
		);
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

	/** The newest request owns the socket from acquisition through its final frame. */
	#watchOrClose(
		socket: WebSocket,
		session: PiSessionId,
		trigger: WatchTrigger,
		window: ConversationWindow = {},
	): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (this.#closed || socket.readyState !== OPEN) return;
			const scope = Scope.makeUnsafe();
			const abort = new AbortController();
			const previous = this.#watchScopes.get(socket);
			const report = watchReporter(trigger, previous !== undefined);
			// Publish ownership before awaiting cleanup or asking Pi to open the watch.
			this.#watchScopes.set(socket, scope);
			const ownsWatch = () => this.#watchScopes.get(socket) === scope;
			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => abort.abort()).pipe(Effect.andThen(report("cancelled"))),
			);

			yield* Effect.gen({ self: this }, function* () {
				if (previous) yield* closeWatchScope(previous);
				if (!ownsWatch()) return;
				const watch = yield* Effect.acquireRelease(
					Effect.tryPromise({
						try: () =>
							this.#harness
								.session(session)
								.watch(window, withAbortSignal(abort.signal, BACKGROUND_CONTEXT)),
						catch: (error) => error,
					}),
					(watch) => Effect.promise(() => watch.stop()),
				).pipe(Scope.provide(scope));
				// A late acquisition is released by its already closed scope.
				if (!ownsWatch()) return;
				let last = watch.value;
				if (!send(socket, { type: "view", session, view: last })) {
					yield* report("failed");
					return yield* this.#disconnectWatch(socket, scope);
				}
				watch.start(async (call) => {
					if (call.kind !== "value" || !ownsWatch()) return;
					if (!send(socket, { type: "ops", session, ops: call.ops })) {
						return Effect.runPromise(this.#disconnectWatch(socket, scope));
					}
					last = call.value;
				});
				// Pi settles this promise when the watch ends, including on scope cleanup.
				void watch.closed.then((end) =>
					Effect.runPromise(this.#ended(socket, session, scope, end, last)),
				);
				yield* report("started");
			}).pipe(
				Effect.catchCause(() =>
					Effect.gen({ self: this }, function* () {
						if (!ownsWatch()) return;
						yield* report("failed");
						yield* this.#disconnectWatch(socket, scope);
					}),
				),
			);
		});
	}

	/**
	 * A watch ended. Unless this class stopped it, pi closed (`ended`) or
	 * failed (`failed`), or the listener threw: watch again, from right after
	 * the last entry the socket got. Opening the session reopens pi.
	 */
	#ended(
		socket: WebSocket,
		session: PiSessionId,
		scope: Scope.Closeable,
		end: WatchEnd,
		last: ConversationView,
	): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (end.kind === "stopped" || end.kind === "aborted") return Effect.void;
			if (this.#watchScopes.get(socket) !== scope) return Effect.void;
			if (socket.readyState !== OPEN) return this.#unwatch(socket);
			return this.#watchOrClose(
				socket,
				session,
				{ trigger: "recovery", previousEnd: end.kind },
				resumeAfter(last),
			);
		});
	}

	#disconnectWatch(socket: WebSocket, scope: Scope.Closeable): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this.#watchScopes.get(socket) !== scope) return Effect.void;
			// A missing delta breaks the sequence, so let the client reconnect from its own cursor.
			return Effect.try(() => socket.close(1011, "Lost the session's watch")).pipe(
				Effect.ignore,
				Effect.andThen(this.#unwatch(socket, scope)),
			);
		});
	}

	#unwatch(socket: WebSocket, expected?: Scope.Closeable): Effect.Effect<void> {
		return Effect.suspend(() => {
			const scope = this.#watchScopes.get(socket);
			if (!scope || (expected !== undefined && scope !== expected)) return Effect.void;
			this.#watchScopes.delete(socket);
			return closeWatchScope(scope);
		});
	}

	#onMessage(connection: Connection, raw: WebSocketMessage): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			if (typeof raw !== "string") return;
			const parsed = parseFrame(raw);
			if (Result.isFailure(parsed)) {
				send(connection, { type: "error", message: "Malformed JSON" });
				return;
			}
			const decoded = decodeClientMessage(parsed.success);
			if (Result.isFailure(decoded)) {
				const request = decodeRequestId(parsed.success);
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
			const result = yield* Effect.result(this.#dispatch(connection, session, message));
			if (Result.isFailure(result)) {
				const error = result.failure;
				send(connection, {
					type: "error",
					...(message.id === undefined ? {} : { id: message.id }),
					message: error instanceof Error ? error.message : String(error),
				});
			} else if (message.id !== undefined) {
				send(connection, { type: "result", id: message.id, result: result.success });
			}
		});
	}

	#dispatch(
		connection: Connection,
		session: PiSessionId,
		message: PiClientMessage,
	): Effect.Effect<PiCommandResult, unknown> {
		return Effect.gen({ self: this }, function* () {
			const handle = yield* Effect.try({
				try: () => this.#harness.session(session),
				catch: (error) => error,
			});
			switch (message.type) {
				case "submit":
					return yield* callPi(() =>
						handle.submit(message.input, {
							...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
							...(message.operationId ? { operationId: message.operationId } : {}),
						}),
					);
				case "abort":
					return yield* callPi(() => handle.abort());
				case "reset":
					return yield* callPi(() => handle.reset(message.handoff)).pipe(Effect.as(null));
				case "watch":
					return yield* this.#watchOrClose(
						connection,
						session,
						{ trigger: "client_request" },
						message.from === undefined ? {} : { from: message.from },
					).pipe(Effect.as(null));
				case "entries":
					return yield* callPi(() =>
						handle.entries(message.query ?? {}, Math.min(message.limit, MAX_PAGE)),
					);
			}
		});
	}
}
