import { AgentClient } from "agents/client";
import { Context, Effect, Layer, Predicate, Queue, Stream } from "effect";
import { ChatAgent, ChatAgentPrefix, ChatName } from "./protocol";

type ChatConnectionEvent =
	| { readonly type: "open" | "close" }
	| { readonly type: "frame"; readonly data: string };

export class ChatConnection extends Context.Service<
	ChatConnection,
	{
		readonly events: Stream.Stream<ChatConnectionEvent>;
		readonly reconnect: Effect.Effect<void>;
	}
>()("trajan/ChatConnection") {
	static readonly live = Layer.effect(
		ChatConnection,
		Effect.gen(function* () {
			const queue = yield* Effect.acquireRelease(
				Queue.unbounded<ChatConnectionEvent>(),
				Queue.shutdown,
			);
			const client = yield* Effect.acquireRelease(
				Effect.sync(() => {
					const socket = new AgentClient({
						agent: ChatAgent,
						name: ChatName,
						prefix: ChatAgentPrefix,
						host: window.location.host,
						protocol: window.location.protocol === "https:" ? "wss" : "ws",
						startClosed: true,
						connectionTimeout: 5000,
						minReconnectionDelay: 750,
					});
					socket.addEventListener("open", () => Queue.offerUnsafe(queue, { type: "open" }));
					socket.addEventListener("close", () => Queue.offerUnsafe(queue, { type: "close" }));
					socket.addEventListener("message", ({ data }) => {
						if (Predicate.isString(data)) {
							Queue.offerUnsafe(queue, { type: "frame", data });
						}
					});
					socket.reconnect();
					return socket;
				}),
				(socket) => Effect.sync(() => socket.close()),
			);
			return {
				events: Stream.fromQueue(queue),
				reconnect: Effect.sync(() => client.reconnect()),
			};
		}),
	);
}
