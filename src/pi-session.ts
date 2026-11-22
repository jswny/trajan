import type { EntryId } from "@earendil-works/pi-durable";
import { AgentClient } from "agents/client";
import { Context, Effect, Layer, Option, Queue, Stream, SubscriptionRef } from "effect";
import { PiSessionMirror } from "./mirror";
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
};

export const INITIAL_SESSION_STATE: SessionState = {
	...EMPTY_VIEW,
	status: "connecting",
	catalog: [],
	loading: false,
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

export const openPiSession = Effect.fn("openPiSession")(function* (connect: () => Socket) {
	const state = yield* SubscriptionRef.make(INITIAL_SESSION_STATE);
	const update = (patch: Partial<SessionState>) =>
		SubscriptionRef.update(state, (current) => ({ ...current, ...patch }));
	const mirror = new PiSessionMirror((view) => Effect.runSync(update(view)));
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
						yield* update({ status: "closed" });
						break;
					case "message": {
						const decoded = decodeServerMessage(event.data);
						if (Option.isNone(decoded)) break;
						const message = decoded.value;
						outbox.receive(message);
						mirror.receive(message);
						if (message.type === "hello") yield* update({ catalog: message.tools });
						if (message.type === "error") yield* update({ error: message.message });
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

	const load = (request: () => Promise<void>) =>
		Effect.gen(function* () {
			const started = yield* SubscriptionRef.modify(state, (current) =>
				current.loading || current.status !== "open"
					? [false, current]
					: [true, { ...current, loading: true }],
			);
			if (!started) return;

			// The error frame or disconnect supplies the user-facing state.
			yield* Effect.tryPromise(request).pipe(
				Effect.ignore,
				Effect.ensuring(update({ loading: false })),
			);
		});

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
					return load(() => mirror.loadEarlier());
				case "fillGap":
					return load(() => mirror.fillGap(command.gap));
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
