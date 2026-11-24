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

test("keeps model continuation data in the checkpoint and passes it only to the follow-up call", async () => {
	const continuation = { opaque: "provider context" };
	const complete = vi.fn<Context.Service.Shape<typeof TurnModel>["complete"]>();
	complete
		.mockReturnValueOnce(
			Effect.succeed({ role: "tool-call", id: "call-1", name: "test", input: null, continuation }),
		)
		.mockReturnValueOnce(Effect.succeed({ role: "assistant", text: "Finished" }));

	const result = await Effect.runPromise(
		runTurn(submission, journal).pipe(
			Effect.provideService(TurnModel, { complete }),
			Effect.provideService(TurnTools, {
				execute: () => Effect.succeed({ status: "completed", output: null }),
			}),
		),
	);

	expect(complete.mock.calls[1]?.[1]).toEqual(continuation);
	expect(result.messages[1]).toEqual({
		role: "tool-call",
		id: "call-1",
		name: "test",
		input: null,
	});
});
