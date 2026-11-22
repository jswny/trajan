import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { openPiSession, type INITIAL_SESSION_STATE } from "../pi-session";
import type { PiClientMessage, PiServerMessage } from "../protocol";

class TestSocket extends EventTarget {
	readyState: number = WebSocket.CLOSED;
	readonly sent: PiClientMessage[] = [];

	reconnect() {
		this.readyState = WebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	close() {
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}

	receive(message: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
	}
}

function snapshot(id: EntryId, before?: EntryId): Extract<PiServerMessage, { type: "view" }> {
	const conversationId = 1 as ConversationId;
	return {
		type: "view",
		session: "1",
		view: {
			conversation: { id: conversationId },
			entries: [
				{
					id,
					conversationId,
					kind: "test.note",
					model: [{ role: "user", content: "Note " + id, timestamp: 0 }],
				},
			],
			before,
			docs: {},
		},
	};
}

type State = typeof INITIAL_SESSION_STATE;

function waitFor(changes: Stream.Stream<State>, predicate: (state: State) => boolean) {
	return changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("3 seconds"));
}

function pageRequest(socket: TestSocket, index: number) {
	const requests = () => socket.sent.filter((message) => message.type === "entries");
	return Effect.promise(async () => {
		await expect.poll(() => requests().length).toBe(index + 1);
		return requests()[index]!;
	});
}

describe("the scoped browser session", () => {
	it("ignores invalid server messages and still applies the next snapshot", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive({ type: "hello", session: "1", tools: null });
					socket.receive({ type: "view", session: "1", view: null });
					socket.receive(snapshot(1 as EntryId));
					socket.receive({ type: "ops", session: "1", ops: [["invalid"]] });
					socket.receive({
						type: "hello",
						session: "1",
						tools: [{ name: "test", description: "Test" }],
					});
					const state = yield* waitFor(session.changes, (state) => state.catalog.length === 1);
					expect(state).toMatchObject({
						_tag: "Some",
						value: { messages: [{ parts: [{ text: "Note 1" }] }], error: null },
					});
				}),
			),
		);
	});

	it("resumes the transcript and replays only unanswered prompts on reconnect", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive(snapshot(1 as EntryId));
					yield* waitFor(session.changes, (state) => state.messages.length === 1);
					expect(socket.sent).toEqual([{ type: "watch" }]);

					yield* session.run({ type: "submit", text: "echo once" });
					const submit = socket.sent.at(-1);
					if (submit?.type !== "submit" || submit.id === undefined) {
						throw new Error("Expected an identified submit");
					}
					socket.close();
					yield* waitFor(session.changes, (state) => state.status === "closed");
					socket.reconnect();
					yield* waitFor(session.changes, (state) => state.status === "open");
					expect(socket.sent.slice(2)).toEqual([{ type: "watch", from: 2 }, submit]);

					socket.receive(snapshot(2 as EntryId, 1 as EntryId));
					socket.receive({ type: "result", id: submit.id, result: { accepted: false } });
					yield* waitFor(session.changes, (state) => state.messages.length === 2);
					socket.close();
					yield* waitFor(session.changes, (state) => state.status === "closed");
					socket.reconnect();
					yield* waitFor(session.changes, (state) => state.status === "open");
					expect(socket.sent.slice(4)).toEqual([{ type: "watch", from: 3 }]);
				}),
			),
		);
		expect(socket.readyState).toBe(WebSocket.CLOSED);
	});

	it("times out a history page and ignores its late replies during a retry", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket, "350 millis");
					socket.receive(snapshot(5 as EntryId, 4 as EntryId));
					yield* waitFor(session.changes, (state) => state.earlier);

					const first = yield* session.run({ type: "loadEarlier" }).pipe(Effect.forkChild);
					const expired = yield* pageRequest(socket, 0);
					yield* Fiber.join(first).pipe(Effect.timeout("3 seconds"));
					expect(yield* Stream.runHead(session.changes)).toMatchObject({
						value: {
							status: "open",
							loading: false,
							historyError: "Loading messages timed out. Try again.",
						},
					});

					const retry = yield* session.run({ type: "loadEarlier" }).pipe(Effect.forkChild);
					const current = yield* pageRequest(socket, 1);
					expect(current.id).not.toBe(expired.id);
					socket.receive({
						type: "result",
						id: expired.id,
						result: { items: snapshot(1 as EntryId).view.entries },
					});
					socket.receive({ type: "error", id: expired.id, message: "late history error" });
					socket.receive({
						type: "hello",
						session: "1",
						tools: [{ name: "test", description: "Test" }],
					});
					const waiting = yield* waitFor(session.changes, (state) => state.catalog.length === 1);
					expect(waiting).toMatchObject({
						value: {
							loading: true,
							error: null,
							historyError: null,
							messages: [{ parts: [{ text: "Note 5" }] }],
						},
					});

					socket.receive({
						type: "result",
						id: current.id,
						result: { items: snapshot(4 as EntryId).view.entries },
					});
					yield* Fiber.join(retry).pipe(Effect.timeout("3 seconds"));
					expect(yield* Stream.runHead(session.changes)).toMatchObject({
						value: {
							loading: false,
							historyError: null,
							messages: [{ parts: [{ text: "Note 4" }] }, { parts: [{ text: "Note 5" }] }],
						},
					});
				}),
			),
		);
	});

	it("releases a page on disconnect and can page again after reconnecting", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive(snapshot(5 as EntryId, 4 as EntryId));
					yield* waitFor(session.changes, (state) => state.earlier);
					const first = yield* session.run({ type: "loadEarlier" }).pipe(Effect.forkChild);
					yield* pageRequest(socket, 0);
					socket.close();
					yield* Fiber.join(first).pipe(Effect.timeout("3 seconds"));
					expect(yield* Stream.runHead(session.changes)).toMatchObject({
						value: { status: "closed", loading: false, historyError: null },
					});

					socket.reconnect();
					yield* waitFor(session.changes, (state) => state.status === "open");
					const retry = yield* session.run({ type: "loadEarlier" }).pipe(Effect.forkChild);
					const current = yield* pageRequest(socket, 1);
					socket.receive({ type: "result", id: current.id, result: { items: null } });
					yield* Fiber.join(retry).pipe(Effect.timeout("3 seconds"));
					expect(yield* Stream.runHead(session.changes)).toMatchObject({
						value: { status: "open", loading: false, historyError: "Invalid history page" },
					});
				}),
			),
		);
	});

	it("releases an in-flight history request when switching sessions", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const oldSocket = new TestSocket();
					const oldScope = yield* Effect.acquireRelease(Scope.make(), Scope.close);
					const oldSession = yield* openPiSession(() => oldSocket).pipe(Scope.provide(oldScope));
					oldSocket.receive(snapshot(5 as EntryId, 4 as EntryId));
					yield* waitFor(oldSession.changes, (state) => state.earlier);

					const loadingPage = yield* oldSession.run({ type: "loadEarlier" }).pipe(Effect.forkChild);
					yield* waitFor(oldSession.changes, (state) => state.loading);
					yield* pageRequest(oldSocket, 0);

					yield* Scope.close(oldScope, Exit.void);
					yield* Fiber.join(loadingPage).pipe(Effect.timeout("3 seconds"));
					expect(oldSocket.readyState).toBe(WebSocket.CLOSED);

					const newSocket = new TestSocket();
					const newSession = yield* openPiSession(() => newSocket);
					oldSocket.receive({ type: "error", message: "late error from old session" });
					const current = yield* waitFor(newSession.changes, (state) => state.status === "open");
					const previous = yield* Stream.runHead(oldSession.changes);
					expect(previous).toMatchObject({ _tag: "Some", value: { loading: false, error: null } });
					expect(current).toMatchObject({
						_tag: "Some",
						value: { messages: [], loading: false, error: null },
					});
					expect(newSocket.sent).toEqual([{ type: "watch" }]);
				}),
			),
		);
	});
});
