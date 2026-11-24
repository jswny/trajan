import { env } from "cloudflare:workers";
import { routeAgentRequest } from "agents";
import { describe, expect, it } from "vite-plus/test";
import { Option } from "effect";
import { PiCommandOutbox } from "../outbox";
import { decodeServerMessage } from "../protocol";
import type { PiServerMessage } from "../protocol";
import { readSessionView } from "./session-view";

async function connect(name: string): Promise<WebSocket> {
	const response = await routeAgentRequest(
		new Request(`https://example.com/agents/pi-harness-test/${name}`, {
			headers: { Upgrade: "websocket" },
		}),
		env,
	);
	expect(response?.status).toBe(101);
	const socket = response?.webSocket;
	if (!socket) {
		throw new Error("Expected the upgraded WebSocket");
	}
	socket.accept();
	return socket;
}

/**
 * Send every pending submit, as the hook does on open; await the `result`
 * or `error` with `id`.
 */
function replay(socket: WebSocket, outbox: PiCommandOutbox, id: string): Promise<PiServerMessage> {
	const answered = new Promise<PiServerMessage>((resolve) => {
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") {
				return;
			}
			const decoded = decodeServerMessage(event.data);
			if (Option.isNone(decoded)) {
				return;
			}
			const message = decoded.value;
			if ((message.type === "result" || message.type === "error") && message.id === id) {
				resolve(message);
			}
		});
	});
	for (const submit of outbox.pending()) {
		socket.send(JSON.stringify(submit));
	}
	return answered;
}

describe("the client command outbox", () => {
	it("names each submit with an operation id and keeps it until a matching receipt", () => {
		const outbox = new PiCommandOutbox();
		const submit = outbox.submit("hello", "followUp");

		expect(submit).toMatchObject({
			type: "submit",
			input: "hello",
			whenBusy: "followUp",
		});
		expect(submit.operationId).toBe(submit.id);
		expect(outbox.pending()).toEqual([submit]);

		const result = { accepted: true, operationId: submit.operationId, session: "1" };
		outbox.receive({ type: "result", id: "other", result });
		expect(outbox.pending()).toEqual([submit]);
		outbox.receive({ type: "result", id: submit.id, result });
		expect(outbox.pending()).toEqual([]);
	});

	it("retains the submit after malformed or mismatched receipts", () => {
		const outbox = new PiCommandOutbox();
		const submit = outbox.submit("hello");
		const receipt = { operationId: submit.operationId, session: "1", accepted: false };
		const invalid = [
			null,
			{ operationId: submit.operationId, accepted: true },
			{ ...receipt, accepted: "false" },
			{ ...receipt, operationId: "another operation" },
		];
		for (const result of invalid) {
			outbox.receive({ type: "result", id: submit.id, result });
			expect(outbox.pending()).toEqual([submit]);
		}
		outbox.receive({ type: "result", id: submit.id, result: receipt });
		expect(outbox.pending()).toEqual([]);
	});

	it("drops a submit the server answered with an error", () => {
		const outbox = new PiCommandOutbox();
		const submit = outbox.submit("hello");
		outbox.receive({ type: "error", id: submit.id, message: "rejected" });
		expect(outbox.pending()).toEqual([]);
	});

	it("sends an unanswered submit again on reconnect without running it twice", async () => {
		const name = crypto.randomUUID();
		const outbox = new PiCommandOutbox();
		const submit = outbox.submit("echo once");

		// The server admits the prompt, but the socket drops before the client
		// reads the result.
		const first = await connect(name);
		await replay(first, outbox, submit.id);
		first.close();
		expect(outbox.pending()).toEqual([submit]);

		const second = await connect(name);
		const result = await replay(second, outbox, submit.id);
		outbox.receive(result);
		second.close();

		expect(result).toMatchObject({ result: { accepted: false } });
		expect(outbox.pending()).toEqual([]);
		const stub = env.PI_HARNESS_TEST.getByName(name);
		await stub.wait(submit.operationId);
		const view = readSessionView(await stub.snapshotView());
		const prompts = view.messages.filter(
			(message) =>
				message.role === "user" &&
				message.parts.some((part) => part.type === "text" && part.text === "echo once"),
		);
		expect(prompts).toHaveLength(1);
	});
});
