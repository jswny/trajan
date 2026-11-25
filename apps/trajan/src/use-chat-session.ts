import { useAtom, useAtomValue } from "@effect/atom-react";
import { Clock, Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { ChatSession, INITIAL_CHAT } from "./chat-session";
import type { ChatCommand, PromptDraft } from "./chat-session";
import { chatMessages, chatText, chatTool } from "./chat-view";

const draftAtom = Atom.make<PromptDraft>({ text: "" }).pipe(Atom.keepAlive);
const sessionAtom = Atom.make(({ registry }) =>
	Stream.unwrap(
		Effect.map(ChatSession, ({ changes, dispatch }) =>
			Stream.map(changes, (state) => ({ state, dispatch })),
		),
	).pipe(
		Stream.provide(ChatSession.live),
		Stream.tap(({ state: { submission } }) =>
			Effect.sync(() => {
				if (submission?.status === "accepted" && registry.get(draftAtom) === submission.draft) {
					registry.set(draftAtom, { text: "" });
				}
			}),
		),
	),
).pipe(Atom.setIdleTTL(0));
const entriesAtom = Atom.make(
	(get) =>
		AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state.page.entries ??
		INITIAL_CHAT.page.entries,
);
const messagesAtom = Atom.make((get) => chatMessages(get(entriesAtom)));
const activeTurnAtom = Atom.make(
	(get) => AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state.active ?? null,
);
const toolPreviewsAtom = Atom.make(
	(get) => AsyncResult.getOrElse(get(sessionAtom), () => undefined)?.state.preview?.tools,
);
const activeMessagesAtom = Atom.make((get) => {
	const active = get(activeTurnAtom);
	return active
		? [
				chatText(`user:${active.submissionId}`, "user", active.prompt),
				...(get(toolPreviewsAtom) ?? []).map(({ call, result, activity }) =>
					chatTool(active.submissionId, call.id, call, result, activity),
				),
			]
		: [];
});
const timelineAtom = Atom.make((get) => [...get(messagesAtom), ...get(activeMessagesAtom)]);
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

export function useChatSession() {
	const session = AsyncResult.getOrElse(useAtomValue(sessionAtom), () => undefined);
	const state = session?.state ?? INITIAL_CHAT;
	const [draft, setDraft] = useAtom(draftAtom);
	const messages = useAtomValue(timelineAtom);
	const submitting = state.submission?.status === "pending";
	const canSubmit =
		state.status === "open" &&
		draft.text.trim() !== "" &&
		draft.text.trim().length <= 32_000 &&
		!submitting &&
		state.submission?.status !== "unconfirmed";
	const dispatch = (command: ChatCommand) => session?.dispatch(command);
	return {
		...state,
		messages,
		earlier: state.page.nextBefore !== null,
		live: state.preview?.text
			? chatText(state.preview.runId, "assistant", state.preview.text)
			: null,
		composer: { text: draft.text, canSubmit, submitting },
		editPrompt: (text: string) => setDraft({ text }),
		submit: () => {
			if (canSubmit) {
				dispatch({ type: "submit", draft });
			}
		},
		retrySubmit: (id: string) => dispatch({ type: "retry", id }),
		stop: () => {
			if (state.active) {
				dispatch({ type: "stop", runId: state.active.runId });
			}
		},
		loadEarlier: () => dispatch({ type: "load-earlier" }),
	};
}
