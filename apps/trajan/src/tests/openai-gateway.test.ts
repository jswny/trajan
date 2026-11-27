import { openAiTurnModel } from "@trajan/model-openai";
import type { OpenAiResponsesTransport } from "@trajan/model-openai";
import { Effect, Exit, Stream } from "effect";
import type { Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { openAiGatewayTransport } from "../chat/openai-gateway";
import { modelConfig } from "../model-config";

function fixtureStream(transport: OpenAiResponsesTransport) {
	return openAiTurnModel(transport, {
		model: "fixture",
		reasoningEffort: "medium",
		compactThreshold: 1000,
		instructions: "Respond to the user.",
		runtimeLabels: modelConfig.runtimeLabels,
		tool: { name: "exec", description: "Run code.", parameters: {} },
	}).stream([], { allowTools: false });
}

function eventResponse(body: BodyInit) {
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function encodeEvent(event: Schema.JsonObject) {
	return `data: ${JSON.stringify(event)}\n\n`;
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
