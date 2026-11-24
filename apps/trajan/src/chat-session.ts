import { Context, Effect, Layer, Queue, Schedule, Schema, SubscriptionRef } from "effect";
import { Socket } from "effect/socket";
import {
	ChatEvent,
	ChatPage,
	ChatPath,
	ChatReceipt,
	ChatStopReceipt,
} from "./effect-harness/chat-protocol";
import type { ChatSnapshot } from "./effect-harness/chat-protocol";

export type PromptDraft = { readonly text: string };
type Submission = {
	readonly id: string;
	readonly draft: PromptDraft;
	readonly status: "pending" | "accepted" | "unconfirmed" | "rejected";
	readonly message?: string;
};
type ChatState = Omit<typeof ChatSnapshot.Type, "type"> & {
	readonly status: "connecting" | "open" | "reconnecting";
	readonly submission: Submission | null;
	readonly loading: boolean;
	readonly requestError: string | null;
};

export const INITIAL_CHAT: ChatState = {
	status: "connecting",
	page: { entries: [], nextBefore: null },
	active: null,
	preview: null,
	queued: 0,
	catalog: [],
	submission: null,
	loading: false,
	requestError: null,
};

export type ChatCommand =
	| { readonly type: "submit"; readonly draft: PromptDraft }
	| { readonly type: "retry"; readonly id: string }
	| { readonly type: "stop"; readonly runId: string }
	| { readonly type: "load-earlier" };

class ChatRequestError extends Schema.TaggedError<
	ChatRequestError,
	{ readonly brand: unique symbol }
>()("ChatRequestError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

const decodeFrame = Schema.decodeEffect(Schema.fromJsonString(ChatEvent));
const decodeReceipt = Schema.decodeUnknownEffect(ChatReceipt);
const decodePage = Schema.decodeUnknownEffect(ChatPage);
const decodeStopReceipt = Schema.decodeUnknownEffect(ChatStopReceipt);

function requestJson(path: string, options?: RequestInit) {
	return Effect.tryPromise({
		try: async (signal) => {
			const response = await fetch(path, { ...options, signal, cache: "no-store" });
			return response.text();
		},
		catch: (cause) =>
			new ChatRequestError({ message: "Trajan did not answer the request.", cause }),
	}).pipe(
		Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))),
		Effect.timeout("5 seconds"),
	);
}

function post(path: string, input: Schema.Json) {
	return requestJson(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
}

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
		case "snapshot":
			return { ...state, ...event, status: "open", page: mergeChatPage(state.page, event.page) };
		case "preview":
			return state.active?.runId === event.runId ? { ...state, preview: event } : state;
		case "text-delta":
			return state.preview?.runId === event.runId
				? { ...state, preview: { ...state.preview, text: state.preview.text + event.text } }
				: state;
	}
}

const openChatSession = Effect.fn("chat.session")(function* () {
	const state = yield* SubscriptionRef.make(INITIAL_CHAT);
	const scope = yield* Effect.scope;
	const commands = yield* Queue.unbounded<ChatCommand>();
	yield* Effect.addFinalizer(() => Queue.shutdown(commands));

	const update = (patch: Partial<ChatState>) =>
		SubscriptionRef.update(state, (state) => ({ ...state, ...patch }));
	const receive = (frame: string) =>
		decodeFrame(frame).pipe(
			Effect.flatMap((event) =>
				SubscriptionRef.update(state, (current) => receiveChatEvent(current, event)),
			),
		);
	const connection = Effect.gen(function* () {
		const url = new URL(`${ChatPath}/live`, window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = yield* Socket.makeWebSocket(url.href, { openTimeout: "5 seconds" });
		const pull = yield* Socket.readerString(socket);
		yield* pull.pipe(
			Effect.timeout("5 seconds"),
			Effect.flatMap(Effect.forEach(receive, { discard: true })),
		);
		if ((yield* SubscriptionRef.get(state)).status !== "open") {
			return yield* new ChatRequestError({ message: "The chat socket did not send a snapshot." });
		}
		return yield* Effect.forever(
			pull.pipe(Effect.flatMap(Effect.forEach(receive, { discard: true }))),
		);
	}).pipe(
		Effect.scoped,
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
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
		yield* post(ChatPath, { id: submission.id, prompt: submission.draft.text.trim() }).pipe(
			Effect.flatMap(decodeReceipt),
			Effect.filterOrFail(
				(receipt) => receipt.submissionId === submission.id,
				() => new ChatRequestError({ message: "The submit receipt did not match." }),
			),
			Effect.retry({ times: 1, schedule: Schedule.spaced("250 millis") }),
			Effect.matchEffect({
				onFailure: () => update({ submission: { ...submission, status: "unconfirmed" } }),
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
		const before = yield* SubscriptionRef.modify(state, (current) => {
			const cursor = current.page.nextBefore;
			return current.loading || current.status !== "open" || cursor === null
				? [null, current]
				: [cursor, { ...current, loading: true, requestError: null }];
		});
		if (before === null) {
			return;
		}
		yield* requestJson(`${ChatPath}/history?before=${before}`).pipe(
			Effect.flatMap(decodePage),
			Effect.matchEffect({
				onFailure: () => update({ requestError: "Couldn’t load earlier messages." }),
				onSuccess: (page) =>
					SubscriptionRef.update(state, (current) =>
						current.page.nextBefore === before
							? {
									...current,
									page: {
										entries: [...page.entries, ...current.page.entries],
										nextBefore: page.nextBefore,
									},
								}
							: current,
					),
			}),
			Effect.ensuring(update({ loading: false })),
		);
	});

	const stop = Effect.fn("chat.stop")(function* (runId: string) {
		const current = yield* SubscriptionRef.get(state);
		if (
			current.status !== "open" ||
			current.active?.runId !== runId ||
			current.active.state === "stopping"
		) {
			return;
		}
		yield* update({ requestError: null });
		yield* post(`${ChatPath}/stop`, { runId }).pipe(
			Effect.flatMap(decodeStopReceipt),
			Effect.filterOrFail(
				(receipt) => receipt.runId === runId,
				() => new ChatRequestError({ message: "The stop receipt did not match." }),
			),
			Effect.catch(() => update({ requestError: "Couldn’t confirm that Trajan stopped." })),
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
		Queue.take(commands).pipe(Effect.flatMap(handle), Effect.forkIn(scope)),
	).pipe(Effect.forkScoped);

	return {
		changes: SubscriptionRef.changes(state),
		dispatch: (command: ChatCommand) => {
			Queue.offerUnsafe(commands, command);
		},
	};
});

export class ChatSession extends Context.Service<
	ChatSession,
	{
		readonly changes: ReturnType<typeof SubscriptionRef.changes<ChatState>>;
		readonly dispatch: (command: ChatCommand) => void;
	}
>()("trajan/ChatSession") {
	static readonly live = Layer.effect(ChatSession, openChatSession());
}
