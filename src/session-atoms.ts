import { Effect, Stream } from "effect";
import { Atom } from "effect/reactivity";
import { readPreference, writePreference } from "./browser-storage";
import { PiSession } from "./pi-session";

const SESSION_KEY = "trajan-session";

function createSessionId(): string {
	const id = crypto.randomUUID();
	writePreference(SESSION_KEY, id);
	return id;
}

export const selectedSessionId = Atom.writable<string, void>(
	() => readPreference(SESSION_KEY) || createSessionId(),
	(ctx) => ctx.setSelf(createSessionId()),
).pipe(Atom.keepAlive);

export function makeActiveSessionAtom(live: typeof PiSession.live = (id) => PiSession.live(id)) {
	const sessionFor = Atom.family((id: string) => {
		const updates = Stream.unwrap(
			Effect.map(PiSession, ({ changes, dispatch }) =>
				Stream.map(changes, (state) => ({ state, dispatch })),
			),
		);
		return Atom.make(updates.pipe(Stream.provide(live(id)))).pipe(Atom.setIdleTTL(0));
	});
	return Atom.make((get) => {
		const id = get(selectedSessionId);
		return { id, session: get(sessionFor(id)) };
	}).pipe(Atom.setIdleTTL(0));
}

export const activeSessionAtom = makeActiveSessionAtom();
