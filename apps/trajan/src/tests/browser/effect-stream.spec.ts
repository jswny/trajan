import { expect, test } from "@playwright/test";
import { TurnTranscript } from "@trajan/effect-harness";
import { Schema } from "effect";
import { TurnStreamEvent } from "../../effect-harness/turn-events";

declare global {
	interface Window {
		recordTurnEvent(data: string): Promise<boolean>;
	}
}

const receipt = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.NonEmptyString }));
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(TurnStreamEvent));
const decodeTurn = Schema.decodeUnknownSync(
	Schema.Struct({
		state: Schema.Literals(["missing", "pending", "running", "completed", "failed"]),
		transcript: Schema.NullOr(TurnTranscript),
	}),
);

test("replaces the interrupted draft after reconnect and commits the turn once", async ({
	page,
	context,
	baseURL,
}) => {
	await context.addCookies([
		{ name: "trajan-fixture", value: crypto.randomUUID(), url: baseURL!, httpOnly: true },
	]);
	const events: Array<typeof TurnStreamEvent.Type> = [];
	let draft = "";
	await page.exposeFunction("recordTurnEvent", (data: string) => {
		const event = decodeEvent(data);
		events.push(event);
		switch (event.type) {
			case "draft":
				draft = event.text;
				break;
			case "text-delta":
				draft += event.text;
				break;
			case "settled":
				return true;
		}
		return false;
	});
	await page.goto("/__browser-smoke/ready");

	const control = "/__browser-smoke/effect-stream";
	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	const post = await page.request.post("/__effect-harness/turns", {
		data: { id: "recover-stream", prompt: "hello" },
	});
	expect(post.status()).toBe(202);
	const { runId } = receipt(await post.json());
	const url = `/__effect-harness/events?runId=${runId}`;
	await page.evaluate((path) => {
		const source = new EventSource(path);
		source.onmessage = async ({ data }: MessageEvent<string>) => {
			if (await window.recordTurnEvent(data)) {
				source.close();
			}
		};
	}, url);
	await expect.poll(() => draft).toBe("Wrote");
	const readTurn = async () => {
		const response = await page.request.get(`/__effect-harness/turns?runId=${runId}`);
		return decodeTurn(await response.json());
	};
	expect(await readTurn()).toMatchObject({ state: "running", transcript: null });

	const beforeCrash = events.length;
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await expect
		.poll(() => events.slice(beforeCrash).some((event) => event.type === "draft"), {
			timeout: 15_000,
		})
		.toBe(true);
	await expect.poll(() => draft).toBe("Wrote");
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect.poll(() => events.at(-1)).toEqual({ type: "settled", state: "completed" });
	expect(await readTurn()).toMatchObject({
		state: "completed",
		transcript: {
			submissionId: "recover-stream",
			messages: [
				{ role: "user", text: "hello" },
				{ role: "tool-call", name: "append", input: { text: "hello" } },
				{ role: "tool", result: { status: "completed", output: "hello" } },
				{ role: "assistant", text: 'Wrote "hello"' },
			],
		},
	});
	const history = await page.request.get("/__effect-harness/history");
	const result = Schema.decodeUnknownSync(
		Schema.Struct({ entries: Schema.Array(Schema.Struct({ submissionId: Schema.String })) }),
	)(await history.json());
	expect(result.entries.map((entry) => entry.submissionId)).toEqual(
		Array.from({ length: 4 }, () => "recover-stream"),
	);
});
