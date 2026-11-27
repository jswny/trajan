import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { createCodeMode } from "./index";
import type {
	CallCheckpoint,
	CodeModeCatalog,
	CodeModeHost,
	CodeModeJournal,
	GuestEvent,
	RunCheckpoint,
} from "./index";

const module = "codemode:tools";
const input = { module, name: "mutate", input: null };
const source = "test script";
const vm = { programId: "test-program", startedAt: 100, seed: 42 };

function testHost({
	fingerprint = "test-quickjs",
	replayedInput = input,
	issued = 1,
	disconnectAfterDelivery = false,
}: {
	fingerprint?: string;
	replayedInput?: Omit<typeof input, "input"> & { input: unknown };
	issued?: number;
	disconnectAfterDelivery?: boolean;
} = {}) {
	const calls = new Map<number, CallCheckpoint>();
	const timeouts: Array<number> = [];
	let run: RunCheckpoint | undefined;
	let replay: Parameters<CodeModeJournal["recordReplay"]>[0] | undefined;
	let attempt = 0;
	const journal: CodeModeJournal = {
		callId: (index) => `test-call:${index}`,
		readRun: () => Option.some(run),
		readCall: (index) => Option.some(calls.get(index)),
		readReplay: () => Option.some(replay),
		start: (checkpoint) =>
			Effect.sync(() => {
				run = checkpoint;
			}),
		recordCall: (index, checkpoint) =>
			Effect.sync(() => {
				calls.set(index, checkpoint);
			}),
		recordReplay: (checkpoint) =>
			Effect.sync(() => {
				replay = checkpoint;
			}),
		finish: (checkpoint) =>
			Effect.sync(() => {
				run = checkpoint;
			}),
		commitCall: () => Effect.die("Unexpected atomic call"),
	};
	const host: CodeModeHost = {
		openJournal: () => journal,
		prepareGuest: () =>
			Effect.succeed({
				programId: vm.programId,
				start: (_, { onEvent, timeoutMs }) => {
					timeouts.push(timeoutMs);
					attempt++;
					const done = Deferred.makeUnsafe<Extract<GuestEvent, { type: "done" | "error" }>>();
					onEvent({ type: "started", fingerprint });
					onEvent({ type: "call", index: 0, call: replayedInput });
					onEvent({ type: "idle", sequence: 0, issued });
					return {
						deliver: ({ index, sequence, at }, reply) => {
							expect(replay?.deliveries[sequence - 1]).toEqual({ index, at });
							Deferred.doneUnsafe(
								done,
								Effect.succeed(
									disconnectAfterDelivery && attempt === 1
										? { type: "error", message: "Guest disconnected before acknowledgment." }
										: { type: "done", sequence, issued, value: reply },
								),
							);
						},
						wait: Deferred.await(done),
						close: async () => {},
					};
				},
			}),
	};
	return { calls, journal, host, timeouts };
}

it.effect("replays the same delivery after a disconnect before the VM acknowledges it", () =>
	Effect.gen(function* () {
		let invocations = 0;
		const { host, calls, journal, timeouts } = testHost({ disconnectAfterDelivery: true });
		const catalog = {
			[module]: {
				mutate: {
					replay: "safe",
					run: (_, context) =>
						Effect.sync(() => {
							expect(calls.get(0)).toEqual({ request: JSON.stringify(input), replay: "safe" });
							invocations++;
							context.recordDetails({ path: "report.txt" });
							return "done";
						}),
				},
			},
		} satisfies CodeModeCatalog;
		const interrupted = yield* createCodeMode(host, catalog).run("run", source).pipe(Effect.flip);
		expect(interrupted.message).toBe("Guest disconnected before acknowledgment.");
		expect(Option.getOrUndefined(journal.readReplay())?.issuedAfter).toEqual([1]);

		yield* TestClock.adjust("10 seconds");
		const recovered = createCodeMode(host, catalog);
		const reply = yield* recovered.run("run", source, { recovering: true });
		expect(reply).toEqual({ status: "returned", value: "done" });
		expect(timeouts).toEqual([25_000, 15_000]);
		expect(Option.getOrUndefined(journal.readReplay())?.issuedAfter).toEqual([1, 1]);
		expect(recovered.readExecution("run", "run").calls).toEqual([
			{
				id: "test-call:0",
				name: "mutate",
				input: null,
				status: "completed",
				reply,
				details: { path: "report.txt" },
			},
		]);
		yield* TestClock.adjust("15 seconds");
		expect(yield* recovered.run("run", source, { recovering: true })).toEqual(reply);
		expect(timeouts).toHaveLength(2);
		expect(invocations).toBe(1);
	}),
);

it.effect("leaves an expired execution's receipts available without starting the VM", () =>
	Effect.gen(function* () {
		const { host, journal, timeouts } = testHost();
		yield* journal.start({ source, vm });
		yield* journal.recordReplay({ fingerprint: "test-quickjs", deliveries: [], issuedAfter: [1] });
		yield* journal.recordCall(0, {
			request: JSON.stringify(input),
			replay: "unsafe",
			started: true,
		});
		yield* TestClock.adjust(25_100);
		const codeMode = createCodeMode(host, {});
		const error = yield* codeMode.run("run", source, { recovering: true }).pipe(Effect.flip);
		expect(error.message).toBe("The Code Mode execution deadline expired.");
		expect(timeouts).toEqual([]);
		expect(codeMode.readExecution("run", "run").calls).toMatchObject([{ status: "interrupted" }]);
	}),
);

it.effect("retries safe or unstarted calls and reports interrupted unsafe effects", () =>
	Effect.gen(function* () {
		for (const { replay, started, shouldRun } of [
			{ replay: "safe", started: undefined, shouldRun: true },
			{ replay: "unsafe", started: true, shouldRun: false },
			{ replay: "unsafe", started: false, shouldRun: true },
		] as const) {
			let invocations = 0;
			const { host, journal } = testHost();
			yield* journal.start({ source, vm });
			yield* journal.recordReplay({
				fingerprint: "test-quickjs",
				deliveries: [],
				issuedAfter: [1],
			});
			yield* journal.recordCall(0, {
				request: JSON.stringify(input),
				replay,
				...(started !== undefined && { started }),
			});
			const codeMode = createCodeMode(host, {
				[module]: {
					mutate: {
						replay,
						run: () =>
							Effect.sync(() => {
								invocations++;
								return "done";
							}),
					},
				},
			});
			const result = yield* codeMode.run("run", source, { recovering: true });
			expect(result).toMatchObject({ status: shouldRun ? "returned" : "interrupted" });
			expect(invocations).toBe(Number(shouldRun));
		}
	}),
);

it.effect("rejects a changed runtime, tool request, or idle boundary before invoking tools", () =>
	Effect.gen(function* () {
		for (const [options, message] of [
			[
				{ fingerprint: "another-version" },
				"The Code Mode sandbox runtime changed during recovery.",
			],
			[{ replayedInput: { ...input, input: "different" } }, "Code Mode replay diverged at call 1."],
			[{ issued: 2 }, "Code Mode replay diverged at a sandbox checkpoint."],
		] as const) {
			const { host, journal } = testHost(options);
			yield* journal.start({ source, vm });
			yield* journal.recordReplay({
				fingerprint: "test-quickjs",
				deliveries: [],
				issuedAfter: [1],
			});
			yield* journal.recordCall(0, {
				request: JSON.stringify(input),
				replay: "unsafe",
				started: false,
			});
			const result = yield* createCodeMode(host, {
				[module]: {
					mutate: { replay: "unsafe", run: () => Effect.die("Unexpected tool call") },
				},
			})
				.run("run", source, { recovering: true })
				.pipe(Effect.flip);
			expect(result.message).toBe(message);
		}
	}),
);
