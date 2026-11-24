import { useAtom, useAtomValue } from "@effect/atom-react";
import type { EntryId } from "@earendil-works/pi-durable";
import { AsyncResult } from "effect/reactivity";
import { INITIAL_SESSION_STATE } from "./pi-session";
import type { SessionCommand, SubmitMode } from "./pi-session";
import { composerAtom, sessionAtom } from "./session-atoms";

export function usePiSession() {
	const result = useAtomValue(sessionAtom);
	const [composer, updateComposer] = useAtom(composerAtom);
	const session = AsyncResult.getOrElse(result, () => undefined);
	const dispatch = (command: SessionCommand) => {
		session?.dispatch(command);
	};

	return {
		...(session?.state ?? INITIAL_SESSION_STATE),
		composer,
		editPrompt: (text: string) => updateComposer({ type: "edit", text }),
		submit: (whenBusy: SubmitMode) => updateComposer({ type: "submit", whenBusy }),
		retrySubmit: (id: string) => dispatch({ type: "retrySubmit", id }),
		retryWatch: () => dispatch({ type: "retryWatch" }),
		abort: () => dispatch({ type: "abort" }),
		reset: () => dispatch({ type: "reset" }),
		loadEarlier: () => dispatch({ type: "loadEarlier" }),
		fillGap: (gap: { after: EntryId; upTo: EntryId }) => dispatch({ type: "fillGap", gap }),
	};
}
