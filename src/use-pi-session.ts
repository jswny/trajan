import { useAtomValue } from "@effect/atom-react";
import type { EntryId } from "@earendil-works/pi-durable";
import { Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";
import { INITIAL_SESSION_STATE, PiSession, type SessionCommand } from "./pi-session";

function sessionAtom(object: string) {
	const changes = Stream.unwrap(
		Effect.map(PiSession, ({ changes, dispatch }) =>
			Stream.map(changes, (state) => ({ state, dispatch })),
		),
	);
	return Atom.make(changes.pipe(Stream.provide(PiSession.live(object)))).pipe(Atom.setIdleTTL(0));
}

export function usePiSession(object: string) {
	const atom = useMemo(() => sessionAtom(object), [object]);
	const session = AsyncResult.getOrElse(useAtomValue(atom), () => undefined);
	const dispatch = (command: SessionCommand) => {
		session?.dispatch(command);
	};

	return {
		...(session?.state ?? INITIAL_SESSION_STATE),
		submit: (text: string, whenBusy?: "followUp" | "steer") =>
			dispatch({ type: "submit", text, whenBusy }),
		abort: () => dispatch({ type: "abort" }),
		reset: () => dispatch({ type: "reset" }),
		loadEarlier: () => dispatch({ type: "loadEarlier" }),
		fillGap: (gap: { after: EntryId; upTo: EntryId }) => dispatch({ type: "fillGap", gap }),
	};
}
