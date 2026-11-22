import { useAtomValue } from "@effect/atom-react";
import type { EntryId } from "@earendil-works/pi-durable";
import { Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";
import { INITIAL_SESSION_STATE, PiSession, type SessionCommand } from "./pi-session";

function sessionAtom(object: string) {
	const changes = Stream.unwrap(
		Effect.gen(function* () {
			const session = yield* PiSession;
			const scope = yield* Effect.scope;
			const run = (command: SessionCommand) => {
				Effect.runFork(Effect.forkIn(session.run(command), scope));
			};
			return Stream.map(session.changes, (state) => ({ state, run }));
		}),
	);
	return Atom.make(changes.pipe(Stream.provide(PiSession.live(object)))).pipe(Atom.setIdleTTL(0));
}

export function usePiSession(object: string) {
	const atom = useMemo(() => sessionAtom(object), [object]);
	const session = AsyncResult.getOrElse(useAtomValue(atom), () => undefined);
	const run = (command: SessionCommand) => session?.run(command);

	return {
		...(session?.state ?? INITIAL_SESSION_STATE),
		submit: (text: string, whenBusy?: "followUp" | "steer") =>
			run({ type: "submit", text, whenBusy }),
		abort: () => run({ type: "abort" }),
		reset: () => run({ type: "reset" }),
		loadEarlier: () => run({ type: "loadEarlier" }),
		fillGap: (gap: { after: EntryId; upTo: EntryId }) => run({ type: "fillGap", gap }),
	};
}
