import { resolve } from "node:path/posix";
import type { ToolLock } from "@trajan/code-mode";
import { Deferred, Effect, Option, Schema } from "effect";

const decodePath = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));
const decodeDirectory = Schema.decodeUnknownOption(
	Schema.NullOr(Schema.Struct({ dir: Schema.optionalKey(Schema.String) })),
);
const file = (input: Schema.Json) =>
	Option.getOrUndefined(Option.map(decodePath(input), ({ path }) => path));
const directory = (input: Schema.Json) =>
	Option.getOrUndefined(Option.map(decodeDirectory(input ?? {}), (args) => args?.dir));

export function workspaceLocks(root: string) {
	const active = new Set<{
		path: string;
		writes: boolean;
		settled: Deferred.Deferred<void>;
	}>();

	function lock(pathOf: (input: Schema.Json) => string | undefined, writes: boolean): ToolLock {
		return {
			withPermit: (effect, input) =>
				Effect.acquireUseRelease(
					Effect.sync(() => {
						const candidate = resolve(root, pathOf(input) ?? ".");
						const path = candidate === root || candidate.startsWith(root + "/") ? candidate : root;
						const previous = Array.from(active)
							.filter(
								(other) =>
									(writes || other.writes) &&
									(other.path === path ||
										other.path.startsWith(path + "/") ||
										path.startsWith(other.path + "/")),
							)
							.map(({ settled }) => settled);
						const reservation = { path, writes, settled: Deferred.makeUnsafe<void>() };
						active.add(reservation);
						return { previous, reservation };
					}),
					({ previous }) =>
						Effect.forEach(previous, Deferred.await, { discard: true }).pipe(
							Effect.andThen(effect),
						),
					({ reservation }) =>
						Effect.sync(() => active.delete(reservation)).pipe(
							Effect.andThen(Deferred.succeed(reservation.settled, undefined)),
						),
				),
		};
	}

	return {
		fileMutation: lock(file, true),
		fileRead: lock(file, false),
		treeRead: lock(() => root, false),
		repository: lock(directory, true),
		remoteGit: lock(() => root, true),
	};
}
