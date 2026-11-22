import {
	BACKGROUND_CONTEXT,
	withAbortSignal,
	type Context as ChordContext,
} from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import { AgentClient } from "agents/client";
import {
	Cause,
	Context,
	Effect,
	Layer,
	Option,
	Queue,
	Stream,
	SubscriptionRef,
	type Duration,
} from "effect";
import { HistoryDisconnected, isHistoryRequest, PiSessionMirror } from "./mirror";
import { PiCommandOutbox } from "./outbox";
import {
	decodeServerMessage,
	type ClientMessage,
	type SessionView,
	type ToolInfo,
} from "./protocol";
import { EMPTY_VIEW } from "./view";

type SessionState = SessionView & {
	readonly status: "connecting" | "open" | "closed";
	readonly catalog: readonly ToolInfo[];
	readonly loading: boolean;
	readonly historyError: string | null;
};

export const INITIAL_SESSION_STATE: SessionState = {
	...EMPTY_VIEW,
	status: "connecting",
	catalog: [],
	loading: false,
	historyError: null,
};

type Gap = { after: EntryId; upTo: EntryId };

export type SessionCommand =
	| { type: "submit"; text: string; whenBusy?: "followUp" | "steer" }
	| { type: "abort" | "reset" }
	| { type: "loadEarlier" }
	| { type: "fillGap"; gap: Gap };

type SocketEvent = { type: "open" | "close" } | { type: "message"; data: unknown };

type Socket = {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	reconnect(): void;
	addEventListener(type: SocketEvent["type"], listener: EventListener): void;
	removeEventListener(type: SocketEvent["type"], listener: EventListener): void;
};

export const openPiSession = Effect.fn("openPiSession")(function* (
	connect: () => Socket,
	pageTimeout?: Duration.Input,
) {
	const state = yield* SubscriptionRef.make(INITIAL_SESSION_STATE);
	const update = (patch: Partial<SessionState>) =>
		SubscriptionRef.update(state, (current) => ({ ...current, ...patch }));
	const mirror = new PiSessionMirror((view) => Effect.runSync(update(view)), pageTimeout);
	const outbox = new PiCommandOutbox();
	const events = yield* Queue.unbounded<SocketEvent>();

	// Keep open, close, and message events in socket order, including across reconnects.
	const onOpen = () => {
		Queue.offerUnsafe(events, { type: "open" });
	};
	const onClose = () => {
		Queue.offerUnsafe(events, { type: "close" });
	};
	const onMessage = (event: Event) => {
		if (event instanceof MessageEvent)
			Queue.offerUnsafe(events, { type: "message", data: event.data });
	};
	const socket = yield* Effect.acquireRelease(Effect.sync(connect), (socket) =>
		Effect.sync(() => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("close", onClose);
			socket.removeEventListener("message", onMessage);
			socket.close();
			mirror.close();
			outbox.clear();
		}),
	);

	const sendRaw = (data: string) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(data);
	};
	const send = (message: ClientMessage) => sendRaw(JSON.stringify(message));

	yield* Stream.fromQueue(events).pipe(
		Stream.runForEach((event) =>
			Effect.gen(function* () {
				switch (event.type) {
					case "open":
						mirror.open(send);
						outbox.sendPending(sendRaw);
						yield* update({ status: "open" });
						break;
					case "close":
						mirror.close();
						yield* update({ status: "closed", historyError: null });
						break;
					case "message": {
						const decoded = decodeServerMessage(event.data);
						if (Option.isNone(decoded)) break;
						const message = decoded.value;
						outbox.receive(message);
						mirror.receive(message);
						if (message.type === "hello") yield* update({ catalog: message.tools });
						if (message.type === "error" && !isHistoryRequest(message.id)) {
							yield* update({ error: message.message });
						}
						break;
					}
				}
			}),
		),
		Effect.forkScoped,
	);
	yield* Effect.sync(() => {
		socket.addEventListener("open", onOpen);
		socket.addEventListener("close", onClose);
		socket.addEventListener("message", onMessage);
		socket.reconnect();
	});

	const load = (request: (context: ChordContext) => Promise<void>) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const started = yield* SubscriptionRef.modify(state, (current) =>
					current.loading || current.status !== "open"
						? [false, current]
						: [true, { ...current, loading: true, historyError: null }],
				);
				if (!started) return;

				yield* restore(
					Effect.tryPromise({
						try: (signal) => request(withAbortSignal(signal, BACKGROUND_CONTEXT)),
						catch: (error) => error,
					}).pipe(
						Effect.catch((error) => {
							if (error instanceof HistoryDisconnected) return Effect.void;
							const historyError = Cause.isTimeoutError(error)
								? "Loading messages timed out. Try again."
								: error instanceof Error
									? error.message
									: "Could not load messages.";
							return update({ historyError });
						}),
					),
				).pipe(Effect.ensuring(update({ loading: false })));
			}),
		);

	const run = (command: SessionCommand) =>
		Effect.suspend(() => {
			switch (command.type) {
				case "submit":
					return Effect.sync(() =>
						send(outbox.submit(command.text, command.whenBusy ?? "followUp")),
					);
				case "abort":
				case "reset":
					return Effect.sync(() => send({ type: command.type, id: crypto.randomUUID() }));
				case "loadEarlier":
					return load((context) => mirror.loadEarlier(context));
				case "fillGap":
					return load((context) => mirror.fillGap(command.gap, context));
			}
		});

	return { changes: SubscriptionRef.changes(state), run };
});

export class PiSession extends Context.Service<PiSession>()("trajan/PiSession", {
	make: openPiSession,
}) {
	static live(object: string) {
		return Layer.effect(
			PiSession,
			openPiSession(
				() =>
					new AgentClient({
						agent: "trajan",
						name: object,
						host: window.location.host,
						protocol: window.location.protocol === "https:" ? "wss" : "ws",
						startClosed: true,
					}),
			),
		);
	}
}
