import { TurnSubmission } from "@trajan/harness";
import { Context, Effect, Layer, Option, Queue, Schedule, Schema, SubscriptionRef } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Socket } from "effect/socket";
import { ChatHttp, ChatRequestError } from "./chat/http-client";
import { ChatEvent, ChatPath, updateToolPreview } from "./chat/protocol";
import type { ChatPage, ChatSnapshot } from "./chat/protocol";

export type PromptDraft = { readonly text: string };
type Submission = {
	readonly id: string;
	readonly draft: PromptDraft;
	readonly restored?: true;
} & (
	| { readonly status: "pending" | "accepted" | "unconfirmed" }
	| { readonly status: "rejected"; readonly message: string }
);
type HistoryRequest = { readonly before: number; readonly status: "pending" | "failed" };
type StopRequest = { readonly runId: string; readonly status: "pending" | "requested" | "failed" };
type ChatState = Omit<typeof ChatSnapshot.Type, "type"> & {
	readonly status: "connecting" | "open" | "reconnecting";
	readonly submission: Submission | null;
	readonly historyRequest: HistoryRequest | null;
	readonly stopRequest: StopRequest | null;
};

export const INITIAL_CHAT: ChatState = {
	status: "connecting",
	page: { entries: [], nextBefore: null },
	active: null,
	preview: null,
	queued: 0,
	catalog: [],
	browserWatch: null,
	submission: null,
	historyRequest: null,
	stopRequest: null,
};

export type ChatCommand =
	| { readonly type: "submit"; readonly draft: PromptDraft }
	| { readonly type: "retry"; readonly id: string }
	| { readonly type: "stop"; readonly runId: string }
	| { readonly type: "load-earlier" };

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(ChatEvent));
const pendingSendKey = "trajan:pending-send";

// The server sends a bounded tail on reconnect. Keep older pages if continuity is known.
export function mergeChatPage(
	current: typeof ChatPage.Type,
	latest: typeof ChatPage.Type,
): typeof ChatPage.Type {
	const last = current.entries.at(-1)?.id;
	const first = latest.entries[0]?.id;
	if (last === undefined || first === undefined || first > last) {
		return latest;
	}
	const appended = latest.entries.filter(({ id }) => id > last);
	return appended.length > 0
		? { entries: [...current.entries, ...appended], nextBefore: current.nextBefore }
		: current;
}

export function receiveChatEvent(state: ChatState, event: typeof ChatEvent.Type): ChatState {
	switch (event.type) {
		case "snapshot": {
			const previous = state.preview?.runId === event.active?.runId ? state.preview : null;
			const preview =
				previous && event.preview
					? {
							...event.preview.tools.reduce(updateToolPreview, previous),
							text: event.preview.text,
						}
					: (event.preview ?? (previous && { ...previous, text: "" }));
			const page = mergeChatPage(state.page, event.page);
			return {
				...state,
				...event,
				status: "open",
				page,
				preview,
				historyRequest:
					state.historyRequest?.before === page.nextBefore ? state.historyRequest : null,
				stopRequest:
					state.stopRequest?.runId === event.active?.runId && event.active?.state !== "stopping"
						? state.stopRequest
						: null,
			};
		}
		case "reset":
		case "tool": {
			if (state.active?.runId !== event.runId) {
				return state;
			}
			const preview =
				state.preview?.runId === event.runId
					? state.preview
					: { runId: event.runId, text: "", tools: [] };
			return {
				...state,
				preview:
					event.type === "reset"
						? { ...preview, text: "" }
						: updateToolPreview(preview, event.tool),
			};
		}
		case "browser":
			return { ...state, browserWatch: event.browserWatch };
		case "text-delta":
			return state.preview?.runId === event.runId
				? { ...state, preview: { ...state.preview, text: state.preview.text + event.text } }
				: state;
	}
}

const openChatSession = Effect.fn("chat.session")(function* () {
	const http = yield* ChatHttp;
	const socket = yield* Socket.Socket;
	const pending = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, TurnSubmission);
	const restored = yield* pending
		.get(pendingSendKey)
		.pipe(Effect.orElseSucceed(Option.none), Effect.map(Option.getOrUndefined));
	const state = yield* SubscriptionRef.make<ChatState>({
		...INITIAL_CHAT,
		submission: restored
			? { id: restored.id, draft: { text: restored.prompt }, status: "unconfirmed", restored: true }
			: null,
	});
	let recoveryId = restored?.id;
	const scope = yield* Effect.scope;
	const commands = yield* Queue.unbounded<ChatCommand>();
	yield* Effect.addFinalizer(() => Queue.shutdown(commands));

	const update = (patch: Partial<ChatState>) =>
		SubscriptionRef.update(state, (state) => ({ ...state, ...patch }));
	const reconcileDelivery = SubscriptionRef.updateEffect(state, (current) => {
		const submission = current.submission;
		if (submission?.status !== "unconfirmed") {
			return Effect.succeed(current);
		}
		const prompt = submission.draft.text.trim();
		const admitted =
			current.active?.submissionId === submission.id && current.active.prompt === prompt;
		const recorded = current.page.entries.some(
			({ submissionId, message }) =>
				submissionId === submission.id && message.role === "user" && message.text === prompt,
		);
		return admitted || recorded
			? pending
					.remove(pendingSendKey)
					.pipe(
						Effect.ignore,
						Effect.as({ ...current, submission: { ...submission, status: "accepted" as const } }),
					)
			: Effect.succeed(current);
	});
	const receive = (frame: string) =>
		decodeFrame(frame).pipe(
			Effect.flatMap((event) =>
				SubscriptionRef.update(state, (current) => receiveChatEvent(current, event)).pipe(
					Effect.andThen(event.type === "snapshot" ? reconcileDelivery : Effect.void),
				),
			),
		);
	const connection = Effect.gen(function* () {
		const pull = yield* Socket.readerString(socket);
		yield* pull.pipe(
			Effect.timeout("5 seconds"),
			Effect.flatMap(Effect.forEach(receive, { discard: true })),
		);
		if ((yield* SubscriptionRef.get(state)).status !== "open") {
			return yield* new ChatRequestError({ message: "The chat socket did not send a snapshot." });
		}
		if (recoveryId !== undefined) {
			const id = recoveryId;
			recoveryId = undefined;
			yield* Queue.offer(commands, { type: "retry", id });
		}
		return yield* Effect.forever(
			pull.pipe(Effect.flatMap(Effect.forEach(receive, { discard: true }))),
		);
	}).pipe(
		Effect.scoped,
		Effect.ensuring(update({ status: "reconnecting" })),
		Effect.catch(() => Effect.sleep("750 millis")),
		Effect.forever,
	);
	yield* Effect.forkScoped(connection);

	const submit = Effect.fn("chat.submit")(function* (
		command: Extract<ChatCommand, { type: "submit" | "retry" }>,
	) {
		const submission = yield* SubscriptionRef.modify(state, (current) => {
			if (current.status !== "open" || current.submission?.status === "pending") {
				return [null, current];
			}
			const previous = current.submission;
			const next =
				command.type === "submit"
					? previous?.status === "unconfirmed"
						? null
						: { id: crypto.randomUUID(), draft: command.draft, status: "pending" as const }
					: previous?.status === "unconfirmed" && previous.id === command.id
						? { ...previous, status: "pending" as const }
						: null;
			return next ? [next, { ...current, submission: next }] : [null, current];
		});
		if (!submission) {
			return;
		}
		const input = { id: submission.id, prompt: submission.draft.text.trim() };
		yield* pending.set(pendingSendKey, input).pipe(Effect.ignore);
		yield* http.submit(input).pipe(
			Effect.filterOrFail(
				(receipt) => receipt.submissionId === submission.id,
				() => new ChatRequestError({ message: "The submit receipt did not match." }),
			),
			Effect.retry({ times: 1, schedule: Schedule.spaced("250 millis") }),
			Effect.tap(() => pending.remove(pendingSendKey).pipe(Effect.ignore)),
			Effect.matchEffect({
				onFailure: () =>
					update({ submission: { ...submission, status: "unconfirmed" } }).pipe(
						Effect.andThen(reconcileDelivery),
					),
				onSuccess: (receipt) =>
					update({
						submission:
							receipt.runId === null
								? { ...submission, status: "rejected", message: receipt.error }
								: { ...submission, status: "accepted" },
					}),
			}),
		);
	});

	const loadEarlier = Effect.fn("chat.loadEarlier")(function* () {
		const before = yield* SubscriptionRef.modify(state, (current): [number | null, ChatState] => {
			const cursor = current.page.nextBefore;
			return current.historyRequest?.status === "pending" ||
				current.status !== "open" ||
				cursor === null
				? [null, current]
				: [cursor, { ...current, historyRequest: { before: cursor, status: "pending" } }];
		});
		if (before === null) {
			return;
		}
		const result = yield* Effect.result(http.history({ before }));
		yield* SubscriptionRef.update(state, (current): ChatState => {
			if (current.historyRequest?.before !== before || current.page.nextBefore !== before) {
				return current;
			}
			return result._tag === "Failure"
				? { ...current, historyRequest: { before, status: "failed" } }
				: {
						...current,
						historyRequest: null,
						page: {
							entries: [...result.success.entries, ...current.page.entries],
							nextBefore: result.success.nextBefore,
						},
					};
		});
		yield* reconcileDelivery;
	});

	const stop = Effect.fn("chat.stop")(function* (runId: string) {
		const admitted = yield* SubscriptionRef.modify(state, (current): [boolean, ChatState] => {
			if (
				current.status !== "open" ||
				current.active?.runId !== runId ||
				current.active.state === "stopping" ||
				(current.stopRequest?.runId === runId && current.stopRequest.status !== "failed")
			) {
				return [false, current];
			}
			return [true, { ...current, stopRequest: { runId, status: "pending" } }];
		});
		if (!admitted) {
			return;
		}
		const acknowledged = yield* http.stop({ runId }).pipe(
			Effect.map((receipt) => receipt.runId === runId && receipt.stopped),
			Effect.orElseSucceed(() => false),
		);
		yield* SubscriptionRef.update(state, (current): ChatState =>
			current.stopRequest?.runId === runId
				? { ...current, stopRequest: { runId, status: acknowledged ? "requested" : "failed" } }
				: current,
		);
	});

	const handle = (command: ChatCommand) => {
		switch (command.type) {
			case "submit":
			case "retry":
				return submit(command);
			case "load-earlier":
				return loadEarlier();
			case "stop":
				return stop(command.runId);
		}
	};
	yield* Effect.forever(
		Queue.take(commands).pipe(Effect.flatMap((command) => Effect.forkIn(handle(command), scope))),
	).pipe(Effect.forkScoped);

	return {
		changes: SubscriptionRef.changes(state),
		dispatch: (command: ChatCommand) => {
			Queue.offerUnsafe(commands, command);
		},
	};
});

const chatSocket = Socket.layerWebSocket(
	Effect.sync(() => {
		const url = new URL(`${ChatPath}/live`, window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		return url.href;
	}),
	{ openTimeout: "5 seconds" },
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));

const pendingSends = Layer.unwrap(
	Effect.try(() => window.sessionStorage).pipe(
		Effect.match({
			onFailure: () => KeyValueStore.layerMemory,
			onSuccess: (storage) => KeyValueStore.layerStorage(() => storage),
		}),
	),
);

export class ChatSession extends Context.Service<
	ChatSession,
	{
		readonly changes: ReturnType<typeof SubscriptionRef.changes<ChatState>>;
		readonly dispatch: (command: ChatCommand) => void;
	}
>()("trajan/ChatSession") {
	static readonly layer = Layer.effect(ChatSession, openChatSession());
	static readonly live = this.layer.pipe(Layer.provide([ChatHttp.live, chatSocket, pendingSends]));
}
