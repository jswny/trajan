import { type Context, Effect, Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { runTurn, type TurnJournal, TurnModel, TurnTools } from "./index";

const submission = { id: "s1", prompt: "Say hello" };

const journal: TurnJournal = {
	checkpoint: (name, schema, run) =>
		run({ idempotencyKey: name, recovering: false }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		),
};

test("stores a direct reply without calling a tool", async () => {
	const execute = vi.fn(() => Effect.succeed({ status: "completed", output: null }));
	const result = await Effect.runPromise(
		runTurn(submission, journal).pipe(
			Effect.provideService(TurnModel, {
				complete: () => Effect.succeed({ role: "assistant", text: "Hello" }),
			}),
			Effect.provideService(TurnTools, { execute }),
		),
	);

	expect(result).toEqual({
		submissionId: "s1",
		messages: [
			{ role: "user", text: "Say hello" },
			{ role: "assistant", text: "Hello" },
		],
	});
	expect(execute).not.toHaveBeenCalled();
});

test("rejects a malformed tool result before sending it back to the model", async () => {
	const complete = vi.fn(() =>
		Effect.succeed({ role: "tool-call", name: "test", id: "call-1", input: null }),
	);
	const result = runTurn(submission, journal).pipe(
		Effect.provideService(TurnModel, { complete }),
		Effect.provideService(TurnTools, {
			execute: () => Effect.succeed({ status: "completed", output: undefined }),
		}),
	);

	await expect(Effect.runPromise(result)).rejects.toMatchObject({ _tag: "SchemaError" });
	expect(complete).toHaveBeenCalledTimes(1);
});

test("passes each continuation back to the model and omits it from the transcript", async () => {
	const first = { role: "tool-call", id: "call-1", name: "test", input: null };
	const second = { ...first, id: "call-2" };
	const firstContinuation = { opaque: "first context" };
	const secondContinuation = { opaque: "second context" };
	const complete = vi.fn<Context.Service.Shape<typeof TurnModel>["complete"]>();
	complete
		.mockReturnValueOnce(Effect.succeed({ ...first, continuation: firstContinuation }))
		.mockReturnValueOnce(Effect.succeed({ ...second, continuation: secondContinuation }))
		.mockReturnValueOnce(Effect.succeed({ role: "assistant", text: "Finished" }));

	const result = await Effect.runPromise(
		runTurn(submission, journal).pipe(
			Effect.provideService(TurnModel, { complete }),
			Effect.provideService(TurnTools, {
				execute: () => Effect.succeed({ status: "completed", output: null }),
			}),
		),
	);

	expect(complete.mock.calls[1]?.[0][1]).toEqual({ ...first, continuation: firstContinuation });
	expect(complete.mock.calls[2]?.[0][1]).toEqual({ ...first, continuation: firstContinuation });
	expect(complete.mock.calls[2]?.[0][3]).toEqual({ ...second, continuation: secondContinuation });
	expect(result.messages[1]).toEqual(first);
	expect(result.messages[3]).toEqual(second);
});

test("bounds tool calls and gives the model a final reply opportunity", async () => {
	const complete = vi.fn<Context.Service.Shape<typeof TurnModel>["complete"]>(
		(messages, { allowTools }) =>
			allowTools
				? Effect.succeed({
						role: "tool-call",
						name: "test",
						id: String(messages.length),
						input: null,
					})
				: Effect.succeed({ role: "assistant", text: "At the tool limit" }),
	);
	const execute = vi.fn<Context.Service.Shape<typeof TurnTools>["execute"]>(() =>
		Effect.succeed({ status: "completed", output: null }),
	);
	const result = await Effect.runPromise(
		runTurn(submission, journal).pipe(
			Effect.provideService(TurnModel, { complete }),
			Effect.provideService(TurnTools, { execute }),
		),
	);

	expect(execute.mock.calls.map(([, attempt]) => attempt.idempotencyKey)).toEqual(
		Array.from({ length: 8 }, (_, index) => `tool:${index}`),
	);
	expect(complete).toHaveBeenCalledTimes(9);
	expect(complete.mock.lastCall?.[1]).toEqual({ allowTools: false });
	expect(result.messages.at(-1)).toEqual({ role: "assistant", text: "At the tool limit" });
});
