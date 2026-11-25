import { openAiTurnModel } from "@trajan/model-openai";
import { Effect, Stream } from "effect";
import type { Schema } from "effect";
import { expect, test } from "vite-plus/test";

function collectEvents(...events: ReadonlyArray<Schema.JsonObject>) {
	const model = openAiTurnModel(
		() =>
			Promise.resolve(
				new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
			),
		{
			model: "fixture",
			reasoningEffort: "medium",
			compactThreshold: 1000,
			instructions: "Respond to the user.",
			tool: { name: "exec", description: "Run code.", parameters: {} },
		},
	);
	return Effect.runPromise(
		model.stream([], { allowTools: false }).pipe(Stream.runCollect, Effect.result),
	);
}

test("ignores unused SSE events and decodes deltas before the completed response", async () => {
	const result = await collectEvents(
		{ type: "response.future_event", payload: { arbitrary: true } },
		{ type: "response.output_text.delta", delta: "Hello" },
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

const failures: ReadonlyArray<{ event: Schema.JsonObject; message: string }> = [
	{
		event: { type: "response.output_text.delta", delta: 42 },
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
