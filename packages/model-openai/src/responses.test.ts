import { Deferred, Effect, Fiber, Stream } from "effect";
import type { Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { openAiTurnModel } from "./index";
import type { OpenAiResponsesTransport } from "./index";

const fixtureOptions = {
	model: "fixture",
	reasoningEffort: "medium",
	compactThreshold: 1000,
	instructions: "Respond to the user.",
	runtimeLabels: { outcome: "Recorded outcome", uncertainEffects: "Uncertain effects" },
	tool: { name: "exec", description: "Run code.", parameters: {} },
};

function fixtureStream(transport: OpenAiResponsesTransport) {
	return openAiTurnModel(transport, fixtureOptions).stream([], { allowTools: false });
}

function eventResponse(body: BodyInit) {
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function encodeEvent(event: Schema.JsonObject) {
	return `data: ${JSON.stringify(event)}\n\n`;
}

function collectEvents(...events: ReadonlyArray<Schema.JsonObject>) {
	const stream = fixtureStream(() =>
		Effect.sync(() => eventResponse(events.map(encodeEvent).join(""))),
	);
	return Effect.runPromise(stream.pipe(Stream.runCollect, Effect.result));
}

test("uses caller instructions and runtime labels in the Responses request", async () => {
	const outcome = {
		role: "runtime-outcome",
		status: "failed",
		text: "The scheduled turn was missed.",
		request: "Check status.",
		tools: [],
	} as const;
	const uncertain = { name: "send", message: "Check whether the request took effect." };
	const call = {
		type: "function_call",
		call_id: "call_1",
		name: "exec",
		arguments: "{}",
	};
	const model = openAiTurnModel(
		(body) =>
			Effect.sync(() => {
				expect(body.instructions).toBe(fixtureOptions.instructions);
				expect(body.input).toEqual([
					{
						type: "message",
						role: "user",
						content: `Recorded outcome\n${JSON.stringify(outcome)}`,
					},
					call,
					{
						type: "function_call_output",
						call_id: "call_1",
						output: [
							{ type: "input_text", text: `Uncertain effects\n${JSON.stringify([uncertain])}` },
							{ type: "input_text", text: '"Done"' },
						],
					},
				]);
				return eventResponse(
					encodeEvent({
						type: "response.completed",
						response: {
							output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
						},
					}),
				);
			}),
		fixtureOptions,
	);
	const stream = model.stream(
		[
			outcome,
			{ role: "tool-call", id: "call_1", name: "exec", input: {}, continuation: [call] },
			{
				role: "tool",
				callId: "call_1",
				result: {
					status: "completed",
					output: "Done",
					uncertainEffects: [{ id: "effect_1", ...uncertain }],
				},
			},
		],
		{ allowTools: true },
	);
	expect(await Effect.runPromise(Stream.runCollect(stream))).toMatchObject([
		{ type: "response", response: { text: "Done" } },
	]);
});

test("ignores unused SSE events and decodes deltas before the completed response", async () => {
	const result = await collectEvents(
		{ type: "response.future_event", payload: { arbitrary: true } },
		{ type: "response.output_text.delta", item_id: "message", delta: "Hello" },
		{
			type: "response.completed",
			response: {
				output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
			},
		},
	);
	expect(result).toMatchObject({
		_tag: "Success",
		success: [
			{ type: "text-delta", text: "Hello" },
			{ type: "response", response: { role: "assistant", text: "Hello" } },
		],
	});
});

test("streams only final answer text when a response includes commentary", async () => {
	const commentary = {
		type: "message",
		id: "progress",
		phase: "commentary",
		content: [],
	};
	expect(
		await collectEvents(
			{ type: "response.output_item.added", item: commentary },
			{ type: "response.output_text.delta", item_id: "progress", delta: "Checking." },
			{ type: "response.output_text.delta", item_id: "answer", delta: "Done." },
			{
				type: "response.completed",
				response: {
					output: [
						{ ...commentary, content: [{ type: "output_text", text: "Checking." }] },
						{
							type: "message",
							phase: "final_answer",
							content: [{ type: "output_text", text: "Done." }],
						},
					],
				},
			},
		),
	).toMatchObject({
		_tag: "Success",
		success: [
			{ type: "text-delta", text: "Done." },
			{ type: "response", response: { role: "assistant", text: "Done." } },
		],
	});
});

test.each([
	{ phase: "headers", wait: "30 seconds", detail: "response headers" },
	{ phase: "body", wait: "90 seconds", detail: "stopped sending events" },
] as const)("aborts an OpenAI request stalled in $phase", ({ phase, wait, detail }) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const started = yield* Deferred.make<AbortSignal>();
			const stream = fixtureStream((_, signal) =>
				Deferred.succeed(started, signal).pipe(
					Effect.andThen(
						phase === "headers"
							? Effect.never
							: Effect.sync(() => eventResponse(new ReadableStream({ start() {} }))),
					),
				),
			);
			const fiber = yield* stream.pipe(Stream.runDrain, Effect.result, Effect.forkScoped);
			const signal = yield* Deferred.await(started);
			yield* TestClock.adjust(wait);
			expect(yield* Fiber.join(fiber)).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "TurnModelError", message: expect.stringContaining(detail) },
			});
			expect(signal.aborted).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
	),
);

const failures: ReadonlyArray<{ event: Schema.JsonObject; message: string }> = [
	{
		event: { type: "response.output_text.delta", item_id: "message", delta: 42 },
		message: "OpenAI returned an invalid response.output_text.delta event.",
	},
	{
		event: { type: "response.completed", response: { output: null } },
		message: "OpenAI returned an invalid response.completed event.",
	},
	{
		event: {
			type: "response.failed",
			response: { error: { message: "upstream failed" }, incomplete_details: null },
		},
		message: "upstream failed",
	},
	{
		event: {
			type: "response.incomplete",
			response: { error: null, incomplete_details: { reason: "max_output_tokens" } },
		},
		message: "max_output_tokens",
	},
	{
		event: { type: "error", message: "stream failed" },
		message: "stream failed",
	},
];

test.each(failures)("reports $event.type as a typed model failure", async ({ event, message }) => {
	expect(await collectEvents(event)).toMatchObject({
		_tag: "Failure",
		failure: { _tag: "TurnModelError", message },
	});
});
