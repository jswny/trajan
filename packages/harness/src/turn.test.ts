import { expect, it, vi } from "@effect/vitest";
import { Effect, Layer, Option, Result, Schema, Stream } from "effect";
import {
	completedToolResult,
	restoreModelContext,
	runTurn,
	toolResultContent,
	ToolResult,
	TurnModel,
	TurnModelError,
	TurnTools,
} from "./index";
import type { TurnCheckpoint, TurnJournal, TurnModelResponse } from "./index";

const submission = { id: "s1", prompt: "Say hello" };
const contextFormat = { adapter: "test", version: 1 };

it("restores compatible model context even when its value is false", () => {
	const model = { contextFormat, contextSchema: Schema.Boolean };
	const saved = { ...contextFormat, state: false };
	expect(restoreModelContext(model, saved)).toEqual(Option.some(false));
});

it.each([
	{ name: "missing", saved: undefined },
	{ name: "from a different adapter", saved: { adapter: "other", version: 1, state: true } },
	{ name: "from a different version", saved: { ...contextFormat, version: 2, state: true } },
	{ name: "incompatible with the schema", saved: { ...contextFormat, state: "true" } },
])("declines to restore saved context when it is $name", ({ saved }) => {
	const model = { contextFormat, contextSchema: Schema.Boolean };
	expect(restoreModelContext(model, saved)).toEqual(Option.none());
});

it("preserves JSON arrays and explicitly selected content across checkpoints", () => {
	const jsonCodec = Schema.fromJsonString(ToolResult);
	const parts = [{ type: "text", text: "ordinary data" }] as const;
	for (const value of [[], parts]) {
		const recorded = Schema.encodeSync(jsonCodec)(completedToolResult(value));
		const restored = Schema.decodeSync(jsonCodec)(recorded);
		if (restored.status !== "completed") {
			throw new Error("Expected a completed tool result");
		}
		expect(toolResultContent(restored)).toEqual({ type: "json", value });
	}
	expect(toolResultContent(completedToolResult({ type: "tool-content", parts }))).toEqual({
		type: "content",
		parts,
	});
});

const journal: TurnJournal = {
	checkpoint: ({ name }, schema, run) =>
		run({ runId: "test-run", idempotencyKey: name, recovering: false }).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		),
};

type Complete = (
	...args: Parameters<TurnModel["Service"]["stream"]>
) => Effect.Effect<TurnModelResponse, TurnModelError>;

function turnLayer(complete: Complete, execute: TurnTools["Service"]["execute"]) {
	return Layer.merge(
		Layer.succeed(
			TurnModel,
			TurnModel.of({
				contextFormat,
				contextSchema: Schema.Json,
				stream: (...args) =>
					complete(...args).pipe(
						Effect.map((response) => ({ type: "response" as const, response })),
						Stream.fromEffect,
					),
			}),
		),
		Layer.succeed(TurnTools, TurnTools.of({ execute })),
	);
}

it.effect("stores a direct reply without calling a tool", () =>
	Effect.gen(function* () {
		const execute = vi.fn<TurnTools["Service"]["execute"]>(() =>
			Effect.succeed({ status: "completed", output: null }),
		);
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

it.effect("keeps a completed reply when its model context exceeds the persistence budget", () =>
	Effect.gen(function* () {
		const result = yield* runTurn(submission, journal).pipe(
			Effect.provide(
				turnLayer(
					() =>
						Effect.succeed({
							role: "assistant",
							text: "Done",
							continuation: "x".repeat(5 * 1024 * 1024),
						}),
					() => Effect.succeed({ status: "completed", output: null }),
				),
			),
		);
		expect(result.messages.at(-1)).toEqual({ role: "assistant", text: "Done" });
		expect(result.modelContext).toBeUndefined();
	}),
);

it.effect("continues after publication fails for a completed tool", () =>
	Effect.gen(function* () {
		const result = yield* runTurn(submission, journal, [], (event) =>
			Effect.sync(() => {
				if (event.type === "tool-result") {
					throw new Error("Observer failed");
				}
			}),
		).pipe(
			Effect.provide(
				turnLayer(
					(history) =>
						Effect.succeed(
							history.at(-1)?.role === "tool"
								? { role: "assistant", text: "Done" }
								: { role: "tool-call", name: "exec", id: "call-1", input: null },
						),
					() => Effect.succeed({ status: "completed", output: "recorded" }),
				),
			),
		);
		expect(result.messages.at(-1)).toEqual({ role: "assistant", text: "Done" });
	}),
);

it.effect("publishes draft text but fails when the stream has no terminal response", () =>
	Effect.gen(function* () {
		const publish = vi.fn(() => Effect.void);
		const result = yield* runTurn(submission, journal, [], publish).pipe(
			Effect.provideService(TurnModel, {
				contextFormat,
				contextSchema: Schema.Json,
				stream: () => Stream.succeed({ type: "text-delta", text: "Partial" }),
			}),
			Effect.provideService(TurnTools, {
				execute: () => Effect.succeed({ status: "completed", output: null }),
			}),
			Effect.result,
		);

		expect(publish.mock.calls).toEqual([
			[{ type: "reset" }],
			[{ type: "text-delta", text: "Partial" }],
			[{ type: "reset" }],
		]);
		expect(Result.isFailure(result) && result.failure).toBeInstanceOf(TurnModelError);
	}),
);

it.effect("rejects a malformed tool result before sending it back to the model", () =>
	Effect.gen(function* () {
		const complete = vi.fn<Complete>(() =>
			Effect.succeed({ role: "tool-call", name: "test", id: "call-1", input: null }),
		);
		const malformedJournal: TurnJournal = {
			checkpoint: (checkpoint, schema, run) =>
				journal.checkpoint(checkpoint, schema, (attempt) =>
					checkpoint.kind === "tool"
						? run(attempt).pipe(Effect.as({ status: "completed", output: undefined }))
						: run(attempt),
				),
		};
		const result = yield* runTurn(submission, malformedJournal).pipe(
			Effect.provide(
				turnLayer(complete, () => Effect.succeed({ status: "completed", output: null })),
			),
			Effect.result,
		);

		expect(Result.isFailure(result) && Schema.isSchemaError(result.failure)).toBe(true);
		expect(complete).toHaveBeenCalledTimes(1);
	}),
);

it.effect("passes each continuation back to the model and omits it from the transcript", () =>
	Effect.gen(function* () {
		const checkpoints: Array<TurnCheckpoint> = [];
		const recordingJournal: TurnJournal = {
			checkpoint: (checkpoint, schema, run) =>
				Effect.sync(() => checkpoints.push(checkpoint)).pipe(
					Effect.andThen(journal.checkpoint(checkpoint, schema, run)),
				),
		};
		const first = { role: "tool-call" as const, id: "call-1", name: "test", input: null };
		const second = { ...first, id: "call-2" };
		const firstContinuation = { opaque: "first context" };
		const secondContinuation = { opaque: "second context" };
		const complete = vi
			.fn<Complete>()
			.mockReturnValueOnce(Effect.succeed({ ...first, continuation: firstContinuation }))
			.mockReturnValueOnce(Effect.succeed({ ...second, continuation: secondContinuation }))
			.mockReturnValueOnce(Effect.succeed({ role: "assistant", text: "Finished" }));

		const result = yield* runTurn(submission, recordingJournal).pipe(
			Effect.provide(
				turnLayer(complete, () => Effect.succeed({ status: "completed", output: null })),
			),
		);

		expect(complete.mock.calls[1]?.[0][1]).toEqual({ ...first, continuation: firstContinuation });
		expect(complete.mock.calls[2]?.[0][1]).toEqual({ ...first, continuation: firstContinuation });
		expect(complete.mock.calls[2]?.[0][3]).toEqual({ ...second, continuation: secondContinuation });
		expect(checkpoints).toEqual([
			{ kind: "model", name: "model:0" },
			{ kind: "tool", name: "tool:0" },
			{ kind: "model", name: "model:1" },
			{ kind: "tool", name: "tool:1" },
			{ kind: "model", name: "model:2" },
		]);
		expect(result.messages[1]).toEqual(first);
		expect(result.messages[3]).toEqual(second);
	}),
);

it.effect("bounds tool calls and gives the model a final reply opportunity", () =>
	Effect.gen(function* () {
		const complete = vi.fn<Complete>((messages, { allowTools }) =>
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
