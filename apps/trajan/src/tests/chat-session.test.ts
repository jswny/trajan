import { TurnSubmission } from "@trajan/harness";
import { Context, Effect, Exit, Layer, Option, Queue, Schema, Scope, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";
import { ChatHttp } from "../chat/http-client";
import { ChatSnapshot } from "../chat/protocol";
import { ChatSession, INITIAL_CHAT, mergeChatPage, receiveChatEvent } from "../chat-session";

function entries(...ids: Array<number>) {
	return ids.map((id) => ({
		id,
		submissionId: String(id),
		message: { role: "user" as const, text: String(id) },
	}));
}

test("keeps earlier history when a reconnect snapshot overlaps the cached tail", () => {
	const cached = { entries: entries(1, 2, 3), nextBefore: null };
	expect(mergeChatPage(cached, { entries: entries(2, 3, 4), nextBefore: 2 })).toEqual({
		entries: entries(1, 2, 3, 4),
		nextBefore: null,
	});
});

test("uses the server's earlier cursor after a reconnect gap", () => {
	const cached = { entries: entries(1, 2, 3), nextBefore: null };
	const latest = { entries: entries(5, 6), nextBefore: 5 };
	expect(mergeChatPage(cached, latest)).toBe(latest);
});

test("a run-state update preserves history and cannot make an unsynced session ready", () => {
	const page = { entries: entries(1, 2), nextBefore: null };
	const next = receiveChatEvent(
		{ ...INITIAL_CHAT, page },
		{
			type: "run-state",
			active: { runId: "run", submissionId: "submit", state: "running", prompt: "Hello" },
			queued: 1,
		},
	);
	expect(next.status).toBe("connecting");
	expect(next.active?.runId).toBe("run");
	expect(next.queued).toBe(1);
	expect(next.page).toBe(page);
});

test("ignores stale deltas and replaces a discarded draft after a new snapshot", () => {
	const base = {
		type: "snapshot" as const,
		page: { entries: [], nextBefore: null },
		queued: 0,
		browserWatch: null,
	};
	const first = receiveChatEvent(INITIAL_CHAT, {
		...base,
		active: { runId: "first", submissionId: "a", state: "running", prompt: "hello" },
		preview: { runId: "first", text: "partial", tools: [] },
	});
	const second = receiveChatEvent(first, {
		...base,
		active: { runId: "second", submissionId: "b", state: "running", prompt: "again" },
		preview: { runId: "second", text: "fresh", tools: [] },
	});
	expect(receiveChatEvent(second, { type: "text-delta", runId: "first", text: "stale" })).toBe(
		second,
	);
	expect(second.preview?.text).toBe("fresh");
});

const snapshot = Schema.encodeSync(Schema.fromJsonString(ChatSnapshot))({
	page: INITIAL_CHAT.page,
	active: null,
	preview: null,
	queued: 0,
	browserWatch: null,
	type: "snapshot",
});
const decodeSubmission = Schema.decodeUnknownSync(Schema.fromJsonString(TurnSubmission));

const socketFixture = Effect.fnUntraced(function* () {
	const opened = yield* Queue.unbounded<void>();
	const closed = yield* Queue.unbounded<void>();
	const frames = yield* Queue.unbounded<[string]>();
	const socket = Socket.make({
		reader: Effect.acquireRelease(Queue.offer(opened, undefined), () =>
			Queue.offer(closed, undefined),
		).pipe(Effect.as({ pull: Queue.take(frames), upgrade: () => Effect.void })),
		writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
	});
	return { socket, opened, closed, sendSnapshot: Queue.offer(frames, [snapshot]) };
});

const sessionFixture = Effect.fnUntraced(function* (
	socket: Socket.Socket,
	fetch: typeof globalThis.fetch,
) {
	const http = Layer.effect(
		HttpClient.HttpClient,
		Effect.map(
			HttpClient.HttpClient,
			HttpClient.mapRequest(HttpClientRequest.prependUrl("https://trajan.test")),
		),
	).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
	);
	const layer = ChatSession.layer.pipe(
		Layer.provide([
			ChatHttp.layer.pipe(Layer.provide(http)),
			Layer.succeed(Socket.Socket, socket),
			KeyValueStore.layerMemory,
		]),
	);
	const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
		Scope.close(scope, Exit.void),
	);
	const context = yield* Layer.buildWithScope(layer, scope);
	return { session: Context.get(context, ChatSession), close: Scope.close(scope, Exit.void) };
});

function runSessionTest<A, E>(effect: Effect.Effect<A, E, Scope.Scope>) {
	return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestClock.layer())));
}

function waitForState(
	session: ChatSession["Service"],
	ready: (state: typeof INITIAL_CHAT) => boolean,
) {
	return session.changes.pipe(Stream.filter(ready), Stream.runHead, Effect.map(Option.getOrThrow));
}

const submitDraft = { type: "submit", draft: { text: " Remember milk " } } as const;

test("reconnects after the initial snapshot times out and holds submissions until ready", () =>
	runSessionTest(
		Effect.gen(function* () {
			const socket = yield* socketFixture();
			let requests = 0;
			const { session } = yield* sessionFixture(socket.socket, () => {
				requests++;
				return Promise.reject(new Error("Unexpected HTTP request"));
			});
			yield* Queue.take(socket.opened);
			session.dispatch(submitDraft);
			yield* TestClock.adjust(4999);
			expect(yield* Queue.size(socket.closed)).toBe(0);
			yield* TestClock.adjust(1);
			expect(yield* Queue.size(socket.closed)).toBe(1);
			const state = yield* waitForState(session, (state) => state.status === "reconnecting");
			expect(state.submission).toBeNull();
			yield* TestClock.adjust(749);
			expect(yield* Queue.size(socket.opened)).toBe(0);
			yield* TestClock.adjust(1);
			yield* Queue.take(socket.opened);
			yield* socket.sendSnapshot;
			yield* waitForState(session, (state) => state.status === "open");
			expect(requests).toBe(0);
		}),
	));

test("retries a timed-out submission with the same ID and accepts its receipt", () =>
	runSessionTest(
		Effect.gen(function* () {
			const socket = yield* socketFixture();
			const attempts = yield* Queue.unbounded<{
				input: typeof TurnSubmission.Type;
				signal: AbortSignal;
			}>();
			let requests = 0;
			const { session } = yield* sessionFixture(socket.socket, async (url, init) => {
				const signal = init?.signal;
				if (!signal) {
					throw new Error("Expected a scoped HTTP request signal");
				}
				const input = decodeSubmission(await new Request(url, init).text());
				if (++requests === 1) {
					return new Promise<Response>((_, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						Queue.offerUnsafe(attempts, { input, signal });
					});
				}
				Queue.offerUnsafe(attempts, { input, signal });
				return Response.json(
					{ submissionId: input.id, runId: "run-1", accepted: true },
					{ status: 202 },
				);
			});
			yield* socket.sendSnapshot;
			yield* waitForState(session, (state) => state.status === "open");
			session.dispatch(submitDraft);
			const first = yield* Queue.take(attempts);
			yield* TestClock.adjust(4999);
			expect(first.signal.aborted).toBe(false);
			yield* TestClock.adjust(1);
			expect(first.signal.aborted).toBe(true);
			yield* TestClock.adjust(249);
			expect(yield* Queue.size(attempts)).toBe(0);
			yield* TestClock.adjust(1);
			const second = yield* Queue.take(attempts);
			expect(second.input).toEqual(first.input);
			expect(second.input.prompt).toBe("Remember milk");
			const state = yield* waitForState(
				session,
				(state) => state.submission?.status === "accepted",
			);
			expect(state.submission?.id).toBe(first.input.id);
		}),
	));

test("closing the session aborts an open HTTP response body and the socket", () =>
	runSessionTest(
		Effect.gen(function* () {
			const socket = yield* socketFixture();
			const bodyReads = yield* Queue.unbounded<AbortSignal>();
			let requests = 0;
			const { session, close } = yield* sessionFixture(socket.socket, (_, init) => {
				const signal = init?.signal;
				if (!signal) {
					throw new Error("Expected a scoped HTTP request signal");
				}
				requests++;
				return Promise.resolve(
					new Response(
						new ReadableStream<Uint8Array>(
							{
								pull(body) {
									return new Promise<void>((resolve) => {
										signal.addEventListener(
											"abort",
											() => {
												body.error(signal.reason);
												resolve();
											},
											{ once: true },
										);
										Queue.offerUnsafe(bodyReads, signal);
									});
								},
							},
							{ highWaterMark: 0 },
						),
						{ status: 202 },
					),
				);
			});
			yield* Queue.take(socket.opened);
			yield* socket.sendSnapshot;
			yield* waitForState(session, (state) => state.status === "open");
			session.dispatch(submitDraft);
			const signal = yield* Queue.take(bodyReads);
			expect(signal.aborted).toBe(false);
			yield* close;
			expect(signal.aborted).toBe(true);
			expect(yield* Queue.size(socket.closed)).toBe(1);
			yield* TestClock.adjust("1 minute");
			expect(yield* Queue.size(socket.opened)).toBe(0);
			expect(requests).toBe(1);
		}),
	));
