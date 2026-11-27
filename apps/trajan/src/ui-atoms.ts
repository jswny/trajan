import { Effect, Stream } from "effect";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";

export function observeAtom<A>(atom: Atom.Atom<A>) {
	return Stream.unwrap(
		Effect.map(AtomRegistry.AtomRegistry, (registry) => AtomRegistry.toStream(registry, atom)),
	);
}
