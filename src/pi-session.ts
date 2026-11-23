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
	Fiber,
	Layer,
	Option,
	Queue,
	Stream,
	SubscriptionRef,
	type Duration,
} from "effect";
import { HistoryDisconnected, isHistoryRequest, PiSessionMirror } from "./mirror";
import { PiCommandOutbox, type PiOutboxSubmit } from "./outbox";
import {
	decodeServerMessage,
	type ClientMessage,
	type SessionView,
	type ToolInfo,
} from "./protocol";
import { EMPTY_VIEW } from "./view";

/** Each edit creates a new draft, so equal text can belong to different revisions. */
export type PromptDraft = { readonly text: string };
export type SubmitMode = "followUp" | "steer";

const RECEIPT_TIMEOUT = "5 seconds";

type Submission = { readonly id: string; readonly draft: PromptDraft } & (
	| { readonly status: "pending" | "accepted" | "unconfirmed" }
	| { readonly status: "rejected"; readonly message: string }
);

type SessionState = SessionView & {
	readonly status: "connecting" | "open" | "closed";
	readonly catalog: readonly ToolInfo[];
	readonly loading: boolean;
	readonly historyError: string | null;
	readonly submission: Submission | null;
	readonly unconfirmedSubmissions: readonly PiOutboxSubmit[];
};

export const INITIAL_SESSION_STATE: SessionState = {
	...EMPTY_VIEW,
	status: "connecting",
	catalog: [],
	loading: false,
	historyError: null,
	submission: null,
	unconfirmedSubmissions: [],
};

type Gap = { after: EntryId; upTo: EntryId };

export type SessionCommand =
	| { type: "submit"; draft: PromptDraft; whenBusy?: SubmitMode }
	| { type: "retrySubmit"; id: string }
	| { type: "abort" | "reset" }
	| { type: "loadEarlier" }
	| { type: "fillGap"; gap: Gap };

type SocketEvent = { type: "open" | "close" } | { type: "message"; data: unknown };
type ReceiptTimeout = { type: "receiptTimeout"; submit: PiOutboxSubmit; canReplay: boolean };
type SessionEvent = SocketEvent | ReceiptTimeout | { type: "command"; command: SessionCommand };

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
	const scope = yield* Effect.scope;
	const events = yield* Queue.unbounded<SessionEvent>();
	const deadlines = new Map<string, { event: ReceiptTimeout; fiber: Fiber.Fiber<void> }>();
	yield* Effect.addFinalizer(() => Queue.shutdown(events));

	// Process socket events and commands in the order they arrive.
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

	const send = (message: ClientMessage) => {
		if (socket.readyState !== WebSocket.OPEN) return false;
		try {
			socket.send(JSON.stringify(message));
			return true;
		} catch {
			return false;
		}
	};
	const cancelDeadline = Effect.fnUntraced(function* (id: string) {
		const deadline = deadlines.get(id);
		if (deadline === undefined) return;
		deadlines.delete(id);
		yield* Fiber.interrupt(deadline.fiber);
	});

	const sendSubmit = Effect.fnUntraced(function* (submit: PiOutboxSubmit, canReplay: boolean) {
		yield* cancelDeadline(submit.id);
		send(submit);
		const event: ReceiptTimeout = { type: "receiptTimeout", submit, canReplay };
		const fiber = yield* Effect.sleep(RECEIPT_TIMEOUT).pipe(
			Effect.andThen(Queue.offer(events, event)),
			Effect.asVoid,
			Effect.forkIn(scope),
		);
		deadlines.set(submit.id, { event, fiber });
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

	const handleCommand = (command: SessionCommand) =>
		Effect.gen(function* () {
			switch (command.type) {
				case "submit": {
					const { status, submission } = yield* SubscriptionRef.get(state);
					const text = command.draft.text.trim();
					if (
						!text ||
						((submission?.status === "pending" || submission?.status === "unconfirmed") &&
							submission.draft === command.draft)
					)
						return;
					const submit = outbox.submit(text, command.whenBusy ?? "followUp");
					if (status === "open") yield* sendSubmit(submit, true);
					yield* update({ submission: { id: submit.id, draft: command.draft, status: "pending" } });
					return;
				}
				case "retrySubmit": {
					const { status, submission, unconfirmedSubmissions } = yield* SubscriptionRef.get(state);
					if (status !== "open") return;
					const submit = unconfirmedSubmissions.find(({ id }) => id === command.id);
					if (submit === undefined) return;
					yield* sendSubmit(submit, false);
					yield* update({
						submission:
							submission?.id === submit.id ? { ...submission, status: "pending" } : submission,
						unconfirmedSubmissions: unconfirmedSubmissions.filter((item) => item !== submit),
					});
					return;
				}
				case "abort":
				case "reset":
					if (!send({ type: command.type, id: crypto.randomUUID() })) {
						yield* update({ error: "Connection lost. Try again when connected." });
					}
					return;
				case "loadEarlier":
					yield* Effect.forkIn(
						load((context) => mirror.loadEarlier(context)),
						scope,
					);
					return;
				case "fillGap":
					yield* Effect.forkIn(
						load((context) => mirror.fillGap(command.gap, context)),
						scope,
					);
					return;
			}
		});

	yield* Stream.fromQueue(events).pipe(
		Stream.runForEach((event) =>
			Effect.gen(function* () {
				switch (event.type) {
					case "command":
						yield* handleCommand(event.command);
						break;
					case "open": {
						mirror.open(send);
						for (const submit of outbox.pending()) yield* sendSubmit(submit, true);
						const { submission } = yield* SubscriptionRef.get(state);
						yield* update({
							status: "open",
							submission:
								submission?.status === "unconfirmed"
									? { ...submission, status: "pending" }
									: submission,
							unconfirmedSubmissions: [],
						});
						break;
					}
					case "close": {
						mirror.close();
						const fibers = Array.from(deadlines.values(), ({ fiber }) => fiber);
						deadlines.clear();
						yield* Fiber.interruptAll(fibers);
						yield* update({ status: "closed", historyError: null });
						break;
					}
					case "receiptTimeout": {
						const { submit, canReplay } = event;
						// A receipt, disconnect or fresh send can invalidate a queued timeout.
						if (deadlines.get(submit.id)?.event !== event) break;
						deadlines.delete(submit.id);
						if (canReplay) {
							yield* sendSubmit(submit, false);
							break;
						}
						const { submission, unconfirmedSubmissions } = yield* SubscriptionRef.get(state);
						yield* update({
							submission:
								submission?.id === submit.id
									? { ...submission, status: "unconfirmed" }
									: submission,
							unconfirmedSubmissions: [...unconfirmedSubmissions, submit],
						});
						break;
					}
					case "message": {
						const decoded = decodeServerMessage(event.data);
						if (Option.isNone(decoded)) break;
						const message = decoded.value;
						mirror.receive(message);
						if (message.type === "hello") yield* update({ catalog: message.tools });
						if (message.type !== "result" && message.type !== "error") break;
						const settledId = outbox.receive(message) ? message.id : undefined;
						const { submission, unconfirmedSubmissions } = yield* SubscriptionRef.get(state);
						const settledLatest = settledId !== undefined && submission?.id === settledId;
						if (settledId !== undefined) {
							yield* cancelDeadline(settledId);
							yield* update({
								submission: !settledLatest
									? submission
									: message.type === "result"
										? { ...submission, status: "accepted" }
										: { ...submission, status: "rejected", message: message.message },
								unconfirmedSubmissions: unconfirmedSubmissions.filter(({ id }) => id !== settledId),
							});
						}
						if (!settledLatest && message.type === "error" && !isHistoryRequest(message.id)) {
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

	const dispatch = (command: SessionCommand) =>
		Queue.offerUnsafe(events, { type: "command", command });
	return { changes: SubscriptionRef.changes(state), dispatch };
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
