import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EntryId } from "@earendil-works/pi-durable";
import { AsyncResult } from "effect/reactivity";
import { INITIAL_SESSION_STATE, type SessionCommand, type SubmitMode } from "./pi-session";
import { activeSessionAtom, composerAtom, selectedSessionId } from "./session-atoms";

export function usePiSession() {
	const { id, session: result } = useAtomValue(activeSessionAtom);
	const [composer, updateComposer] = useAtom(composerAtom);
	const newSession = useAtomSet(selectedSessionId);
	const session = AsyncResult.getOrElse(result, () => undefined);
	const dispatch = (command: SessionCommand) => {
		session?.dispatch(command);
	};

	return {
		...(session?.state ?? INITIAL_SESSION_STATE),
		id,
		newSession,
		composer,
		editPrompt: (text: string) => updateComposer({ type: "edit", text }),
		submit: (whenBusy: SubmitMode) => updateComposer({ type: "submit", whenBusy }),
		abort: () => dispatch({ type: "abort" }),
		reset: () => dispatch({ type: "reset" }),
		loadEarlier: () => dispatch({ type: "loadEarlier" }),
		fillGap: (gap: { after: EntryId; upTo: EntryId }) => dispatch({ type: "fillGap", gap }),
	};
}
