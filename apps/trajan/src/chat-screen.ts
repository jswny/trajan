import { TurnPrompt } from "@trajan/harness";
import { Clock, Effect, Schema, Stream } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { AsyncResult, Atom } from "effect/reactivity";
import { ChatSession, INITIAL_CHAT } from "./chat-session";
import type { PromptDraft } from "./chat-session";
import { chatText, chatTool, ChatTurn, chatTurns } from "./chat-view";

export const draftAtom = Atom.make<PromptDraft>({ text: "" }).pipe(Atom.keepAlive);
const isTurnPrompt = Schema.is(TurnPrompt);
const sessionAtom = Atom.make(({ registry }) => {
	let restoredDraft = false;
	return Stream.unwrap(
		Effect.map(ChatSession, ({ changes, dispatch }) =>
			Stream.map(changes, (state) => ({ state, dispatch })),
		),
	).pipe(
		Stream.provide(ChatSession.live),
		Stream.tap(({ state: { submission } }) =>
			Effect.sync(() => {
				if (submission?.restored && !restoredDraft) {
					restoredDraft = true;
					if (submission.status !== "accepted" && registry.get(draftAtom).text === "") {
						registry.set(draftAtom, submission.draft);
					}
				}
				if (submission?.status === "accepted" && registry.get(draftAtom) === submission.draft) {
					registry.set(draftAtom, { text: "" });
				}
			}),
		),
	);
}).pipe(Atom.setIdleTTL(0));
const entriesAtom = Atom.make(
	(get) =>
		AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state.page.entries ??
		INITIAL_CHAT.page.entries,
);
const historyTurnsAtom = Atom.make((get) => chatTurns(get(entriesAtom)));
const runAtom = Atom.make(
	(get) => AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state.active ?? null,
);
const previewAtom = Atom.make(
	(get) => AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state.preview,
);
const toolPreviewsAtom = Atom.make((get) => get(previewAtom)?.tools);
const activeMessagesAtom = Atom.make((get) => {
	const active = get(runAtom);
	return active
		? [
				chatText(`user:${active.submissionId}`, "user", active.prompt),
				...(get(toolPreviewsAtom) ?? []).map(({ call, result, activity }) =>
					chatTool(active.submissionId, call.id, call, result, activity),
				),
			]
		: [];
});
const activeTurnAtom = Atom.make((get): ChatTurn | null => {
	const active = get(runAtom);
	const preview = get(previewAtom);
	return active
		? {
				submissionId: active.submissionId,
				messages: get(activeMessagesAtom),
				live: preview?.text ? chatText(active.runId, "assistant", preview.text) : null,
				working: true,
			}
		: null;
});
const timelineAtom = Atom.make((get) => {
	const history = get(historyTurnsAtom);
	const active = get(activeTurnAtom);
	return active ? [...history, active] : history;
});
const browserWatchAtom = Atom.make(
	(get) => AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state.browserWatch ?? null,
);
const activeBrowserAtom = Atom.make((get) => {
	const watch = get(browserWatchAtom);
	return Stream.unwrap(
		Effect.map(Clock.currentTimeMillis, (now) => {
			if (!watch || watch.expiresAt <= now) {
				return Stream.succeed(null);
			}
			return Stream.concat(
				Stream.succeed(watch.id),
				Stream.fromEffect(Effect.sleep(watch.expiresAt - now).pipe(Effect.as(null))),
			);
		}),
	);
});

export const browserWatchId = Atom.make((get) =>
	AsyncResult.getOrElse(get(activeBrowserAtom), () => null),
);

export const ChatActivity = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("browser"),
		working: Schema.Boolean,
		inspectable: Schema.Boolean,
	}),
	Schema.Struct({ kind: Schema.Literals(["waiting", "responding", "stopping"]) }),
	Schema.Struct({ kind: Schema.Literal("tool"), name: Schema.String }),
]);
export type ChatActivity = typeof ChatActivity.Type;

const activityAtom = Atom.make((get): ChatActivity | null => {
	const state = AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state ?? INITIAL_CHAT;
	const browserOpen = get(browserWatchId) !== null;
	const inspectable = browserOpen && state.status === "open";
	if (!state.active) {
		return browserOpen ? { kind: "browser", working: false, inspectable } : null;
	}
	if (state.active.state === "stopping") {
		return { kind: "stopping" };
	}
	const latest = state.preview?.tools.at(-1);
	const tool = latest?.result ? undefined : latest;
	if (
		state.status === "open" &&
		state.active.state === "running" &&
		tool?.activity.some(({ category, status }) => category === "browser" && status === "running")
	) {
		return { kind: "browser", working: true, inspectable };
	}
	if (state.preview?.text) {
		return { kind: "responding" };
	}
	return tool ? { kind: "tool", name: tool.call.name } : { kind: "waiting" };
});

const SubmissionNotice = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("unconfirmed"),
		id: Schema.String,
		prompt: Schema.String,
	}),
	Schema.Struct({ status: Schema.Literal("rejected"), message: Schema.String }),
]);
export const ChatScreen = Schema.Struct({
	status: Schema.Literals(["connecting", "open", "reconnecting"]),
	turns: Schema.Array(ChatTurn),
	activity: Schema.NullOr(ChatActivity),
	loading: Schema.Boolean,
	stopping: Schema.Boolean,
	requestError: Schema.NullOr(Schema.String),
	earlier: Schema.Boolean,
	notice: Schema.NullOr(SubmissionNotice),
	running: Schema.Boolean,
	queued: Schema.Natural,
	canSubmit: Schema.Boolean,
	submitting: Schema.Boolean,
});

export const initialScreen: typeof ChatScreen.Type = {
	status: "connecting",
	turns: [],
	activity: null,
	loading: false,
	stopping: false,
	requestError: null,
	earlier: false,
	notice: null,
	running: false,
	queued: 0,
	canSubmit: false,
	submitting: false,
};

function canSend(state: typeof INITIAL_CHAT, draft: PromptDraft) {
	return (
		state.status === "open" &&
		isTurnPrompt(draft.text.trim()) &&
		state.submission?.status !== "pending" &&
		state.submission?.status !== "unconfirmed"
	);
}

export const chatScreen = Atom.make((get): typeof ChatScreen.Type => {
	const state = AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state ?? INITIAL_CHAT;
	const draft = get(draftAtom);
	const submission = state.submission;
	return {
		status: state.status,
		turns: get(timelineAtom),
		activity: get(activityAtom),
		loading: state.historyRequest?.status === "pending",
		stopping:
			state.active?.state === "stopping" ||
			state.stopRequest?.status === "pending" ||
			state.stopRequest?.status === "requested",
		requestError:
			state.stopRequest?.status === "failed"
				? "Couldn’t confirm that Trajan stopped."
				: state.historyRequest?.status === "failed"
					? "Couldn’t load earlier messages."
					: null,
		earlier: state.page.nextBefore !== null,
		notice:
			submission?.status === "unconfirmed"
				? {
						status: "unconfirmed",
						id: submission.id,
						prompt: submission.draft.text,
					}
				: submission?.status === "rejected"
					? { status: "rejected", message: submission.message }
					: null,
		running: state.active !== null,
		queued: state.queued,
		canSubmit: canSend(state, draft),
		submitting: submission?.status === "pending",
	};
});

export const ScreenAction = Schema.Union([
	Schema.Struct({ type: Schema.Literal("retry"), id: Schema.String }),
	Schema.Struct({ type: Schema.Literals(["submit", "stop", "load-earlier"]) }),
]);

export function dispatchChat(
	registry: AtomRegistry.AtomRegistry,
	action: typeof ScreenAction.Type,
) {
	const session = AsyncResult.getOrElse(registry.get(sessionAtom), () => undefined);
	if (action.type === "submit") {
		const draft = registry.get(draftAtom);
		if (session && canSend(session.state, draft)) {
			session.dispatch({ type: "submit", draft });
		}
	} else if (action.type === "stop") {
		if (session?.state.active) {
			session.dispatch({ type: "stop", runId: session.state.active.runId });
		}
	} else {
		session?.dispatch(action.type === "retry" ? action : { type: "load-earlier" });
	}
}
