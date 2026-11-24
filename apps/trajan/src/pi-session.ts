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
	Result,
	Stream,
	SubscriptionRef,
} from "effect";
import { MAIN_CHAT_NAME } from "./main-chat";
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
const WATCH_TIMEOUT = "5 seconds";

type Submission = { readonly id: string; readonly draft: PromptDraft } & (
	| { readonly status: "pending" | "accepted" | "unconfirmed" }
	| { readonly status: "rejected"; readonly message: string }
);

type SessionState = SessionView & {
	readonly status: "connecting" | "open" | "closed";
	readonly transcriptStatus: "syncing" | "synced" | "failed";
	readonly catalog: readonly ToolInfo[];
	readonly loading: boolean;
	readonly historyError: string | null;
	readonly submission: Submission | null;
	readonly unconfirmedSubmissions: readonly PiOutboxSubmit[];
};

export const INITIAL_SESSION_STATE: SessionState = {
	...EMPTY_VIEW,
	status: "connecting",
	transcriptStatus: "syncing",
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
	| { type: "retryWatch" }
	| { type: "abort" | "reset" }
	| { type: "loadEarlier" }
	| { type: "fillGap"; gap: Gap };

type SocketEvent = { type: "open" | "close" } | { type: "message"; data: unknown };
type ReceiptTimeout = { type: "receiptTimeout"; submit: PiOutboxSubmit; canReplay: boolean };
type WatchTimeout = { type: "watchTimeout"; canRetry: boolean };
type SessionEvent =
	| SocketEvent
	| ReceiptTimeout
	| WatchTimeout
	| { type: "command"; command: SessionCommand };

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
	// Pi calls the page loader through a Promise. Keep the session clock across that boundary.
	const runPage = Effect.runPromiseWith(yield* Effect.context());
	const mirror = new PiSessionMirror(runPage);
	const publishView = (patch?: Partial<SessionState>) =>
		SubscriptionRef.update(state, (current) => ({ ...current, ...mirror.view, ...patch }));
	const outbox = new PiCommandOutbox();
	const scope = yield* Effect.scope;
	const events = yield* Queue.unbounded<SessionEvent>();
	const deadlines = new Map<string, { event: ReceiptTimeout; fiber: Fiber.Fiber<void> }>();
	let watchDeadline: { event: WatchTimeout; fiber: Fiber.Fiber<void> } | undefined;
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
			outbox.clear();
		}).pipe(Effect.andThen(mirror.close())),
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
	const cancelWatchDeadline = Effect.suspend(() => {
		const deadline = watchDeadline;
		watchDeadline = undefined;
		return deadline === undefined ? Effect.void : Fiber.interrupt(deadline.fiber);
	});

	const startWatch = Effect.fnUntraced(function* (canRetry: boolean) {
		yield* cancelWatchDeadline;
		yield* update({ transcriptStatus: "syncing" });
		mirror.open(send);
		const event: WatchTimeout = { type: "watchTimeout", canRetry };
		const fiber = yield* Effect.sleep(WATCH_TIMEOUT).pipe(
			Effect.andThen(Queue.offer(events, event)),
			Effect.asVoid,
			Effect.forkIn(scope),
		);
		watchDeadline = { event, fiber };
	});

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

	const load = (request: Effect.Effect<SessionView | undefined, unknown>) =>
		Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const started = yield* SubscriptionRef.modify(state, (current) =>
					current.loading || current.status !== "open" || current.transcriptStatus !== "synced"
						? [false, current]
						: [true, { ...current, loading: true, historyError: null }],
				);
				if (!started) return;

				yield* restore(
					request.pipe(
						Effect.flatMap((view) => (view === undefined ? Effect.void : publishView())),
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
				case "retryWatch": {
					const { status, transcriptStatus } = yield* SubscriptionRef.get(state);
					if (status === "open" && transcriptStatus === "failed") yield* startWatch(false);
					return;
				}
				case "abort":
				case "reset":
					if (!send({ type: command.type, id: crypto.randomUUID() })) {
						yield* update({ error: "Connection lost. Try again when connected." });
					}
					return;
				case "loadEarlier":
					yield* Effect.forkIn(load(mirror.loadEarlier()), scope);
					return;
				case "fillGap":
					yield* Effect.forkIn(load(mirror.fillGap(command.gap)), scope);
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
						yield* startWatch(true);
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
						yield* mirror.close();
						yield* cancelWatchDeadline;
						const fibers = Array.from(deadlines.values(), ({ fiber }) => fiber);
						deadlines.clear();
						yield* Fiber.interruptAll(fibers);
						yield* update({ status: "closed", transcriptStatus: "syncing", historyError: null });
						break;
					}
					case "watchTimeout": {
						if (watchDeadline?.event !== event) break;
						watchDeadline = undefined;
						if (event.canRetry) yield* startWatch(false);
						else yield* update({ transcriptStatus: "failed" });
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
						const received = yield* Effect.result(mirror.receive(message));
						if (Result.isFailure(received)) {
							const { status, transcriptStatus } = yield* SubscriptionRef.get(state);
							if (status === "open" && transcriptStatus === "synced") yield* startWatch(true);
							break;
						}
						if (message.type === "view") {
							if (received.success !== undefined) {
								yield* cancelWatchDeadline;
								yield* publishView({ transcriptStatus: "synced" });
							}
							break;
						}
						if (received.success !== undefined) yield* publishView();
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
	static live() {
		return Layer.effect(
			PiSession,
			openPiSession(
				() =>
					new AgentClient({
						agent: "trajan",
						name: MAIN_CHAT_NAME,
						host: window.location.host,
						protocol: window.location.protocol === "https:" ? "wss" : "ws",
						startClosed: true,
					}),
			),
		);
	}
}
