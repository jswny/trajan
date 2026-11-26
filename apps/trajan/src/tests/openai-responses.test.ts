import { openAiTurnModel } from "@trajan/model-openai";
import type { OpenAiResponsesTransport } from "@trajan/model-openai";
import { Deferred, Effect, Exit, Fiber, Stream } from "effect";
import type { Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { openAiGatewayTransport } from "../chat/openai-gateway";

function fixtureStream(transport: OpenAiResponsesTransport) {
	return openAiTurnModel(transport, {
		model: "fixture",
		reasoningEffort: "medium",
		compactThreshold: 1000,
		instructions: "Respond to the user.",
		tool: { name: "exec", description: "Run code.", parameters: {} },
	}).stream([], { allowTools: false });
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

test("reports gateway request rejections as typed model failures", async () => {
	const error = new Error("Gateway unavailable");
	const stream = fixtureStream(openAiGatewayTransport({ run: () => Promise.reject(error) }));
	expect(await Effect.runPromise(stream.pipe(Stream.runDrain, Effect.result))).toMatchObject({
		_tag: "Failure",
		failure: { _tag: "TurnModelError", message: error.message, cause: error },
	});
});

test("aborts the gateway request while waiting for response headers", async () => {
	const started = Promise.withResolvers<AbortSignal>();
	const controller = new AbortController();
	const stream = fixtureStream(
		openAiGatewayTransport({
			run: (_, options) => {
				const signal = options?.signal;
				if (!signal) {
					throw new Error("Expected a gateway request signal.");
				}
				return new Promise<Response>((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					started.resolve(signal);
				});
			},
		}),
	);
	const pending = Effect.runPromiseExit(Stream.runDrain(stream), { signal: controller.signal });
	const signal = await started.promise;
	expect(signal.aborted).toBe(false);
	controller.abort();
	expect(Exit.hasInterrupts(await pending)).toBe(true);
	expect(signal.aborted).toBe(true);
});

test("keeps the gateway request alive through streaming and aborts it on interruption", async () => {
	const started = Promise.withResolvers<AbortSignal>();
	const firstDelta = Promise.withResolvers<void>();
	const controller = new AbortController();
	let bodyCancelled = false;
	const stream = fixtureStream(
		openAiGatewayTransport({
			run: (_, options) => {
				const signal = options?.signal;
				if (!signal) {
					throw new Error("Expected a gateway request signal.");
				}
				started.resolve(signal);
				return Promise.resolve(
					eventResponse(
						new ReadableStream<Uint8Array>({
							start(body) {
								body.enqueue(
									new TextEncoder().encode(
										encodeEvent({
											type: "response.output_text.delta",
											item_id: "message",
											delta: "Hello",
										}),
									),
								);
							},
							cancel() {
								bodyCancelled = true;
							},
						}),
					),
				);
			},
		}),
	);
	const pending = Effect.runPromiseExit(
		stream.pipe(Stream.runForEach(() => Effect.sync(() => firstDelta.resolve()))),
		{ signal: controller.signal },
	);
	const signal = await started.promise;
	await firstDelta.promise;
	expect(signal.aborted).toBe(false);
	controller.abort();
	expect(Exit.hasInterrupts(await pending)).toBe(true);
	expect(signal.aborted).toBe(true);
	expect(bodyCancelled).toBe(true);
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
