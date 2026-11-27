import { expect, it } from "@effect/vitest";
import { Effect, Option, Result } from "effect";
import { createCodeMode } from "./index";
import type {
	CallCheckpoint,
	CodeModeCatalog,
	CodeModeHost,
	CodeModeJournal,
	RunCheckpoint,
} from "./index";

const module = "codemode:tools";
const input = { module, name: "mutate", input: null };
const source = "test script";

function testHost(runGuest: CodeModeHost["runGuest"]) {
	const calls = new Map<number, CallCheckpoint>();
	let run: RunCheckpoint | undefined;
	const journal: CodeModeJournal = {
		callId: (index) => `test-call:${index}`,
		readRun: () => Option.some(run),
		readCall: (index) => Option.some(calls.get(index)),
		start: (source) => {
			run = { source };
		},
		recordCall: (index, checkpoint) =>
			Effect.sync(() => {
				calls.set(index, checkpoint);
			}),
		finish: (checkpoint) =>
			Effect.sync(() => {
				run = checkpoint;
			}),
		commitCall: () => Effect.die("This test only exercises safe and unsafe calls."),
	};
	return { calls, journal, host: { runGuest, openJournal: () => journal } };
}

it.effect("reuses a completed call after interruption and preserves its receipt", () =>
	Effect.gen(function* () {
		let attempt = 0;
		let invocations = 0;
		const { host, calls } = testHost(async (_, __, call) => {
			const reply = await call(input);
			if (++attempt === 1) {
				throw new Error("Guest disconnected after receiving the reply.");
			}
			return reply;
		});
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
		const interrupted = yield* createCodeMode(host, catalog).run("run", source).pipe(Effect.result);
		expect(Result.isFailure(interrupted)).toBe(true);

		const recovered = createCodeMode(host, catalog);
		const reply = yield* recovered.run("run", source, { recovering: true });
		expect(reply).toEqual({ status: "returned", value: "done" });
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
		expect(invocations).toBe(1);
	}),
);

it.effect("retries a pending safe call and reports a pending unsafe call", () =>
	Effect.gen(function* () {
		for (const replay of ["safe", "unsafe"] as const) {
			let invocations = 0;
			const { host, journal } = testHost((_, __, call) => call(input));
			journal.start(source);
			yield* journal.recordCall(0, { request: JSON.stringify(input), replay });
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
			expect(result).toMatchObject({ status: replay === "safe" ? "returned" : "interrupted" });
			expect(invocations).toBe(replay === "safe" ? 1 : 0);
		}
	}),
);

it.effect("rejects a divergent replay before invoking the new call", () =>
	Effect.gen(function* () {
		const { host, journal } = testHost((_, __, call) => call({ ...input, input: "different" }));
		journal.start(source);
		yield* journal.recordCall(0, { request: JSON.stringify(input), replay: "unsafe" });
		const result = yield* createCodeMode(host, {
			[module]: {
				mutate: { replay: "unsafe", run: () => Effect.die("Unexpected tool call") },
			},
		})
			.run("run", source, { recovering: true })
			.pipe(Effect.flip);
		expect(result.message).toBe("Code Mode replay diverged at call 1.");
	}),
);
