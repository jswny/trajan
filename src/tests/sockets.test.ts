import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Watch } from "@earendil-works/chord/watch";
import {
	createRegistry,
	type ConversationId,
	type ConversationView,
	type EntryId,
} from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import type { Connection } from "agents/lifecycle";
import { Option } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { PiSessionMirror } from "../mirror";
import { decodeServerMessage, type PiServerMessage } from "../protocol";
import { PiSessionSockets } from "../sockets";
import type { PiMessage } from "../transcript";

async function connect(name: string, query = ""): Promise<WebSocket> {
	const response = await routeAgentRequest(
		new Request(`https://example.com/agents/pi-harness-test/${name}${query}`, {
			headers: { Upgrade: "websocket" },
		}),
		env,
	);
	expect(response?.status).toBe(101);
	const socket = response!.webSocket as WebSocket;
	socket.accept();
	return socket;
}

/** The close code `socket` gets. */
function closed(socket: WebSocket): Promise<number> {
	return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
}

/**
 * Follows the session as the browser hook does: asks to watch it each time
 * a socket opens, and mirrors every frame into a `PiSessionMirror`.
 */
function follow(socket: WebSocket) {
	const mirror = new PiSessionMirror(() => {});
	const frames: PiServerMessage[] = [];
	const waiters: Array<() => void> = [];
	const attach = (next: WebSocket) => {
		next.addEventListener("message", (event) => {
			const decoded = decodeServerMessage(event.data);
			if (Option.isNone(decoded)) return;
			const frame = decoded.value;
			frames.push(frame);
			mirror.receive(frame);
			for (const waiter of waiters.splice(0)) waiter();
		});
		mirror.open((message) => next.send(JSON.stringify(message)));
	};
	attach(socket);
	/** The socket dropped; follow on `next`, as a reconnect does. */
	const reconnect = (next: WebSocket) => {
		mirror.close();
		attach(next);
	};
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 500 && !check(); i++) {
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 20);
			});
		}
		if (!check()) throw new Error("Condition never held");
	};
	const views = () => frames.filter((frame) => frame.type === "view").length;
	return { view: () => mirror.view, mirror, frames, views, until, reconnect };
}

function textOf(message: PiMessage): string {
	return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The texts of the messages that start with `prefix `. */
function notes(messages: readonly PiMessage[], prefix: string): string[] {
	return messages.map(textOf).filter((text) => text.startsWith(`${prefix} `));
}

function numbered(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

describe("the session WebSocket protocol", () => {
	it.each(["resolves", "rejects"])(
		"keeps a client's watch when an older wake-up watch %s late",
		async (outcome) => {
			const harness = new PiHarness({
				harness: async () => {
					throw new Error("Unexpected Pi open");
				},
			});
			const session = harness.session(ROOT_SESSION);
			vi.spyOn(harness, "session").mockReturnValue(session);
			vi.spyOn(harness.sessions, "list").mockResolvedValue([{ id: ROOT_SESSION, busy: false }]);
			const view = (before: number): ConversationView => ({
				conversation: { id: 1 as ConversationId },
				before: before as EntryId,
				entries: [],
				docs: {},
			});
			const stale = new Watch(view(5), vi.fn(), vi.fn());
			const current = new Watch(view(10), vi.fn(), vi.fn());
			const pending = Promise.withResolvers<typeof stale>();
			const watch = vi
				.spyOn(session, "watch")
				.mockReturnValueOnce(pending.promise)
				.mockResolvedValueOnce(current);
			const { 0: client, 1: server } = new WebSocketPair();
			const socket: Connection = Object.assign(server, {
				id: "connection",
				uri: null,
				state: null,
				setState: () => null,
				tags: ["connection", "pi-session:" + ROOT_SESSION],
			});
			const frames: PiServerMessage[] = [];
			client.addEventListener("message", (event) => {
				frames.push(JSON.parse(event.data));
			});
			client.accept();
			socket.accept();
			const sockets = new PiSessionSockets(harness, createRegistry(), () => [socket]);
			const handlers = sockets.options().handlers!;
			const wake = sockets.reattach();

			try {
				await expect.poll(() => watch.mock.calls.length).toBe(1);
				await handlers.onMessage!(socket, JSON.stringify({ type: "watch", from: 11 }));
				if (outcome === "resolves") pending.resolve(stale);
				else pending.reject(new Error("Superseded watch failed"));
				await wake;

				expect(socket.readyState).toBe(WebSocket.OPEN);
				expect(watch.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(true);
				if (outcome === "resolves") expect(await stale.closed).toEqual({ kind: "stopped" });
				current.advance(
					{ kind: "value", value: view(11), retired: false, ops: [["s", ["before"], 11]] },
					BACKGROUND_CONTEXT,
				);
				await expect
					.poll(() => frames)
					.toEqual([
						{ type: "view", session: ROOT_SESSION, view: view(10) },
						{ type: "ops", session: ROOT_SESSION, ops: [["s", ["before"], 11]] },
					]);
				await handlers.onClose!(socket, 1000, "", true);
				expect(await current.closed).toEqual({ kind: "stopped" });
				expect(watch.mock.calls[1]?.[1]?.abortSignal?.aborted).toBe(true);
			} finally {
				await sockets.close();
				pending.resolve(stale);
				await wake;
				client.close();
			}
		},
	);

	it("rejects invalid requests and continues to serve the socket", async () => {
		const socket = await connect(crypto.randomUUID());
		const client = follow(socket);
		await client.until(() => client.views() > 0);
		const invalid = [
			{ type: "unknown", id: "unknown" },
			{ type: "submit", id: "bad-input", input: [{ type: "text", text: 1 }] },
			{ type: "submit", id: "bad-policy", input: "hello", whenBusy: "send" },
			{ type: "entries", id: "bad-limit", limit: 0 },
			{ type: "entries", id: "bad-query", query: { order: "up" }, limit: 1 },
		];
		socket.send("{");
		socket.send("null");
		for (const request of invalid) socket.send(JSON.stringify(request));
		await client.until(() => client.frames.filter((frame) => frame.type === "error").length === 7);
		expect(client.frames.filter((frame) => frame.type === "error")).toEqual([
			{ type: "error", message: "Malformed JSON" },
			{ type: "error", message: "Invalid session message" },
			...invalid.map(({ id }) => ({ type: "error", id, message: "Invalid session message" })),
		]);

		socket.send(JSON.stringify({ type: "entries", id: "page", limit: 1 }));
		await client.until(() =>
			client.frames.some((frame) => frame.type === "result" && frame.id === "page"),
		);
		socket.close();
	});

	it("sends the view, then pi's operations for a run started over the socket", async () => {
		const name = crypto.randomUUID();
		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.views() > 0);
		expect(client.frames.find((frame) => frame.type === "hello")).toMatchObject({
			session: "1",
			tools: expect.arrayContaining([expect.objectContaining({ name: "multiply" })]),
		});

		socket.send(JSON.stringify({ type: "submit", id: "c1", input: "multiply 7" }));
		await client.until(() =>
			client
				.view()
				.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.parts.some((part) => part.type === "text" && part.text === "tool said: 21"),
				),
		);
		await client.until(() => !client.view().running);
		expect(client.frames.find((frame) => frame.type === "result")).toMatchObject({
			id: "c1",
			result: { session: "1", accepted: true },
		});
		// The operations rebuilt the same view a client joining now gets.
		const stub = env.PI_HARNESS_TEST.getByName(name);
		expect(client.view()).toEqual(JSON.parse(await stub.snapshotView()));
		socket.close();
	});

	it("gives a client that joins mid-run the running state", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		const receipt = await stub.submit("gate");
		await stub.gateStarted(1);

		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.view().running);
		expect(client.view().tools.map((tool) => tool.name)).toEqual(["gate"]);
		expect(client.view().tools[0]?.output).toBe("run 1\n");

		await stub.release();
		await stub.wait(receipt.operationId);
		await client.until(() => !client.view().running);
		expect(client.view().messages.at(-1)?.parts[0]).toEqual({
			type: "text",
			text: "tool said: released after 1 runs",
		});
		socket.close();
	});

	it("keeps serving a hibernated socket after the object is evicted", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.views() > 0);

		await evictDurableObject(stub);
		const before = client.views();
		// The next call restarts the object; its start re-watches the socket.
		const result = await stub.prompt("after hibernation");
		expect(result.text).toBe("echo: after hibernation");
		await client.until(() =>
			client
				.view()
				.messages.some((message) =>
					message.parts.some(
						(part) => part.type === "text" && part.text === "echo: after hibernation",
					),
				),
		);
		expect(client.views()).toBe(before + 1);
		socket.close();
	});

	it("watches again when pi closes and the harness reopens it", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.views() > 0);

		await stub.closePi();
		// The next call reopens pi; the socket follows the reopened one.
		const result = await stub.prompt("after the reopen");
		expect(result.text).toBe("echo: after the reopen");
		await client.until(() =>
			client.view().messages.some((message) => textOf(message) === "echo: after the reopen"),
		);
		expect(client.views()).toBe(2);
		socket.close();
	});

	it("closes the socket while pi does not reopen, so the client reconnects", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.views() > 0);
		await stub.prompt("before the failure");

		await stub.failOpens(true);
		const lost = closed(socket);
		await stub.closePi();
		expect(await lost).toBe(1011);

		// A reconnect while pi still does not open is closed too, rather than
		// left open without a watch.
		const retry = await connect(name);
		const retryLost = closed(retry);
		client.reconnect(retry);
		expect(await retryLost).toBe(1011);

		await stub.failOpens(false);
		const next = await connect(name);
		client.reconnect(next);
		await client.until(() => client.views() > 1);
		const result = await stub.prompt("after the reopen");
		expect(result.text).toBe("echo: after the reopen");
		await client.until(() =>
			client.view().messages.some((message) => textOf(message) === "echo: after the reopen"),
		);
		expect(
			client
				.view()
				.messages.map(textOf)
				.filter((text) => text.length > 0),
		).toEqual([
			"before the failure",
			"echo: before the failure",
			"after the reopen",
			"echo: after the reopen",
		]);
		next.close();
	});

	it("keeps the messages a client saw after they leave the watch's window", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.views() > 0);

		// More than the server ever holds in one window, a batch at a time.
		for (let batch = 0; batch < 15; batch++) {
			await stub.appendNotes(`batch ${batch}:`, 30);
			await client.until(() =>
				client.view().messages.some((message) => textOf(message) === `batch ${batch}: 30`),
			);
		}
		const texts = client.view().messages.map(textOf);
		expect(texts).toHaveLength(450);
		expect(texts.slice(0, 2)).toEqual(["batch 0: 1", "batch 0: 2"]);
		expect(texts.at(-1)).toBe("batch 14: 30");
		expect(client.view().earlier).toBe(false);
		socket.close();
	});

	it("loads earlier messages a page at a time", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		await stub.appendNotes("note", 450);

		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.views() > 0);
		// The window holds only the newest entries.
		const first = notes(client.view().messages, "note");
		expect(first.length).toBeLessThan(450);
		expect(first.at(-1)).toBe("note 450");
		expect(client.view().earlier).toBe(true);

		let pages = 0;
		while (client.view().earlier) {
			await client.mirror.loadEarlier();
			pages++;
		}
		expect(pages).toBeGreaterThan(1);
		expect(notes(client.view().messages, "note")).toEqual(numbered("note", 450));
		socket.close();
	});

	it("does not page back past the newest reset", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		await stub.appendNotes("before", 60);
		await stub.reset();
		await stub.appendNotes("after", 60);

		const socket = await connect(name);
		const client = follow(socket);
		await client.until(() => client.views() > 0);
		expect(client.view().earlier).toBe(true);

		await client.mirror.loadEarlier();
		// The page reached the reset: nothing before it shows or loads.
		expect(client.view().earlier).toBe(false);
		const { messages } = client.view();
		expect(messages[0]).toMatchObject({ role: "notice" });
		expect(textOf(messages[0])).toBe("Context reset");
		expect(notes(messages, "after")).toEqual(numbered("after", 60));
		expect(notes(messages, "before")).toEqual([]);
		socket.close();
	});

	it("fills the gap a long disconnection leaves", async () => {
		const name = crypto.randomUUID();
		const stub = env.PI_HARNESS_TEST.getByName(name);
		await stub.appendNotes("old", 10);
		const first = await connect(name);
		const client = follow(first);
		await client.until(() => client.views() > 0);
		first.close();

		// More than a window's worth arrives while the client is away.
		await stub.appendNotes("missed", 200);
		const second = await connect(name);
		client.reconnect(second);
		await client.until(() => client.views() > 1);

		const gap = client.view().messages.find((message) => message.role === "gap");
		expect(gap).toBeDefined();
		expect(notes(client.view().messages, "old")).toEqual(numbered("old", 10));
		const nextGap = () =>
			client
				.view()
				.messages.find(
					(message): message is Extract<PiMessage, { role: "gap" }> => message.role === "gap",
				);
		for (let next = nextGap(); next !== undefined; next = nextGap()) {
			await client.mirror.fillGap(next);
		}
		expect(notes(client.view().messages, "missed")).toEqual(numbered("missed", 200));
		second.close();
	});
});
