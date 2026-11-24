import { expect, it, vi } from "@effect/vitest";
import { Effect, Layer, Result, Schema } from "effect";
import { runTurn, TurnModel, TurnTools } from "./index";
import type { TurnJournal } from "./index";

const submission = { id: "s1", prompt: "Say hello" };

const journal: TurnJournal = {
	checkpoint: (name, schema, run) =>
		run({ idempotencyKey: name, recovering: false }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		),
};

function turnLayer(
	complete: TurnModel["Service"]["complete"],
	execute: TurnTools["Service"]["execute"],
) {
	return Layer.merge(
		Layer.succeed(TurnModel, TurnModel.of({ complete })),
		Layer.succeed(TurnTools, TurnTools.of({ execute })),
	);
}

it.effect("stores a direct reply without calling a tool", () =>
	Effect.gen(function* () {
		const execute = vi.fn(() => Effect.succeed({ status: "completed", output: null }));
		const result = yield* runTurn(submission, journal).pipe(
			Effect.provide(
				turnLayer(() => Effect.succeed({ role: "assistant", text: "Hello" }), execute),
			),
		);

		expect(result).toEqual({
			submissionId: "s1",
			messages: [
				{ role: "user", text: submission.prompt },
				{ role: "assistant", text: "Hello" },
			],
		});
		expect(execute).not.toHaveBeenCalled();
	}),
);

it.effect("rejects a malformed tool result before sending it back to the model", () =>
	Effect.gen(function* () {
		const complete = vi.fn(() =>
			Effect.succeed({ role: "tool-call", name: "test", id: "call-1", input: null }),
		);
		const result = yield* runTurn(submission, journal).pipe(
			Effect.provide(
				turnLayer(complete, () => Effect.succeed({ status: "completed", output: undefined })),
			),
			Effect.result,
		);

		expect(Result.isFailure(result) && Schema.isSchemaError(result.failure)).toBe(true);
		expect(complete).toHaveBeenCalledTimes(1);
	}),
);

it.effect("passes each continuation back to the model and omits it from the transcript", () =>
	Effect.gen(function* () {
		const first = { role: "tool-call", id: "call-1", name: "test", input: null };
		const second = { ...first, id: "call-2" };
		const firstContinuation = { opaque: "first context" };
		const secondContinuation = { opaque: "second context" };
		const complete = vi
			.fn<TurnModel["Service"]["complete"]>()
			.mockReturnValueOnce(Effect.succeed({ ...first, continuation: firstContinuation }))
			.mockReturnValueOnce(Effect.succeed({ ...second, continuation: secondContinuation }))
			.mockReturnValueOnce(Effect.succeed({ role: "assistant", text: "Finished" }));

		const result = yield* runTurn(submission, journal).pipe(
			Effect.provide(
				turnLayer(complete, () => Effect.succeed({ status: "completed", output: null })),
			),
		);

		expect(complete.mock.calls[1]?.[0][1]).toEqual({ ...first, continuation: firstContinuation });
		expect(complete.mock.calls[2]?.[0][1]).toEqual({ ...first, continuation: firstContinuation });
		expect(complete.mock.calls[2]?.[0][3]).toEqual({ ...second, continuation: secondContinuation });
		expect(result.messages[1]).toEqual(first);
		expect(result.messages[3]).toEqual(second);
	}),
);

it.effect("bounds tool calls and gives the model a final reply opportunity", () =>
	Effect.gen(function* () {
		const complete = vi.fn<TurnModel["Service"]["complete"]>((messages, { allowTools }) =>
			allowTools
				? Effect.succeed({
						role: "tool-call",
						name: "test",
						id: String(messages.length),
						input: null,
					})
				: Effect.succeed({ role: "assistant", text: "At the tool limit" }),
		);
		const execute = vi.fn<TurnTools["Service"]["execute"]>(() =>
			Effect.succeed({ status: "completed", output: null }),
		);
		const result = yield* runTurn(submission, journal).pipe(
			Effect.provide(turnLayer(complete, execute)),
		);

		expect(execute.mock.calls.map(([, attempt]) => attempt.idempotencyKey)).toEqual(
			Array.from({ length: 8 }, (_, index) => `tool:${index}`),
		);
		expect(complete).toHaveBeenCalledTimes(9);
		expect(complete.mock.lastCall?.[1]).toEqual({ allowTools: false });
		expect(result.messages.at(-1)).toEqual({ role: "assistant", text: "At the tool limit" });
	}),
);
