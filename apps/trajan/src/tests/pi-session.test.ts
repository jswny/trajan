import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";
import { openPiSession, PiSession, type INITIAL_SESSION_STATE } from "../pi-session";
import {
	decodeEntriesPage,
	decodeServerMessage,
	type PiClientMessage,
	type PiServerMessage,
} from "../protocol";
import { makeSessionAtoms } from "../session-atoms";

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

	acknowledge(submit: Extract<PiClientMessage, { type: "submit" }>, accepted = true) {
		this.receive({
			type: "result",
			id: submit.id,
			result: { operationId: submit.operationId, session: "1", accepted },
		});
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
	it("shares one socket between the chat and composer and closes it when they are released", async () => {
		const openSocket = vi.fn(() => new TestSocket());
		const { sessionAtom, composerAtom } = makeSessionAtoms(
			Layer.effect(PiSession, openPiSession(openSocket)),
		);
		const registry = AtomRegistry.make();
		try {
			const unmountSession = registry.mount(sessionAtom);
			const unmountComposer = registry.mount(composerAtom);
			await expect.poll(() => openSocket.mock.results[0]?.value?.sent).toEqual([{ type: "watch" }]);
			const socket = openSocket.mock.results[0]!.value!;
			socket.receive(snapshot(5 as EntryId));
			await expect
				.poll(() => registry.get(sessionAtom))
				.toMatchObject({
					value: { state: { messages: [{ parts: [{ text: "Note 5" }] }] } },
				});
			expect(openSocket).toHaveBeenCalledTimes(1);
			unmountSession();
			expect(socket.readyState).toBe(WebSocket.OPEN);
			unmountComposer();
			await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED);
		} finally {
			registry.dispose();
		}
	});

	it("clears only the accepted draft revision and keeps rejected text available to retry", async () => {
		const socket = new TestSocket();
		const { sessionAtom, composerAtom: composer } = makeSessionAtoms(
			Layer.effect(
				PiSession,
				openPiSession(() => socket),
			),
		);
		const registry = AtomRegistry.make();
		const edit = (text: string) => registry.set(composer, { type: "edit", text });
		const submit = () => registry.set(composer, { type: "submit", whenBusy: "followUp" });
		const latestSubmit = () => socket.sent.filter((frame) => frame.type === "submit").at(-1)!;
		try {
			registry.mount(composer);
			edit("same text");
			await expect.poll(() => socket.sent).toEqual([{ type: "watch" }]);
			expect(registry.get(composer).canSubmit).toBe(false);
			socket.receive(snapshot(1 as EntryId));
			await expect.poll(() => registry.get(composer).canSubmit).toBe(true);
			submit();
			await expect.poll(() => registry.get(composer).submitting).toBe(true);
			const first = latestSubmit();

			edit("new text");
			edit("same text");
			socket.acknowledge(first);
			await expect
				.poll(() => registry.get(sessionAtom))
				.toMatchObject({
					value: { state: { submission: { id: first.id, status: "accepted" } } },
				});
			expect(registry.get(composer)).toEqual({
				text: "same text",
				submitting: false,
				canSubmit: true,
			});

			submit();
			await expect.poll(() => registry.get(composer).submitting).toBe(true);
			const second = latestSubmit();
			expect(second.id).not.toBe(first.id);
			socket.receive({ type: "error", id: second.id, message: "Rejected" });
			await expect
				.poll(() => registry.get(composer))
				.toEqual({ text: "same text", submitting: false, canSubmit: true });

			submit();
			await expect.poll(() => registry.get(composer).submitting).toBe(true);
			socket.acknowledge(latestSubmit());
			await expect
				.poll(() => registry.get(composer))
				.toEqual({ text: "", submitting: false, canSubmit: false });
		} finally {
			registry.dispose();
		}
	});

	it("ignores invalid server messages and still applies the next snapshot", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive({ type: "hello", session: "1", tools: null });
					socket.receive({ type: "view", session: "1", view: null });
					const malformed = snapshot(2 as EntryId);
					socket.receive({ ...malformed, view: { ...malformed.view, docs: { "pi.inbox": {} } } });
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

					session.dispatch({ type: "submit", draft: { text: "echo once" } });
					yield* waitFor(session.changes, (state) => state.submission?.status === "pending");
					const submit = socket.sent.at(-1);
					if (submit?.type !== "submit" || submit.id === undefined) {
						throw new Error("Expected an identified submit");
					}
					socket.close();
					yield* waitFor(session.changes, (state) => state.status === "closed");
					yield* TestClock.adjust("10 seconds");
					expect(socket.sent.slice(2)).toEqual([]);
					socket.reconnect();
					yield* waitFor(session.changes, (state) => state.status === "open");
					expect(socket.sent.slice(2)).toEqual([{ type: "watch", from: 2 }, submit]);
					// This patch needs the new watch's snapshot, which has not arrived yet.
					socket.receive({
						type: "ops",
						session: "1",
						ops: [["p", ["entries"], 1, 0, snapshot(9 as EntryId).view.entries]],
					});
					socket.receive({
						type: "hello",
						session: "1",
						tools: [{ name: "marker", description: "" }],
					});
					const syncing = yield* waitFor(session.changes, (state) => state.catalog.length === 1);
					expect(syncing).toMatchObject({
						value: { transcriptStatus: "syncing", messages: [{ parts: [{ text: "Note 1" }] }] },
					});

					socket.receive(snapshot(2 as EntryId, 1 as EntryId));
					socket.acknowledge(submit, false);
					const acknowledged = yield* waitFor(
						session.changes,
						(state) => state.submission?.status === "accepted",
					);
					expect(acknowledged).toMatchObject({
						value: {
							transcriptStatus: "synced",
							messages: [{}, {}],
							submission: { id: submit.id },
						},
					});
					socket.close();
					yield* waitFor(session.changes, (state) => state.status === "closed");
					socket.reconnect();
					yield* waitFor(session.changes, (state) => state.status === "open");
					socket.receive(snapshot(2 as EntryId, 1 as EntryId));
					yield* waitFor(session.changes, (state) => state.transcriptStatus === "synced");
					yield* TestClock.adjust("10 seconds");
					expect(socket.sent.slice(4)).toEqual([{ type: "watch", from: 3 }]);
				}),
			).pipe(Effect.provide(TestClock.layer())),
		);
		expect(socket.readyState).toBe(WebSocket.CLOSED);
	});

	it.each([
		{ field: "entries", ops: [["d", ["entries"]]] },
		{
			field: "pi.inbox",
			ops: [
				["p", ["entries"], 1, 0, snapshot(9 as EntryId).view.entries],
				["s", ["docs", "pi.inbox"], {}],
			],
		},
	])(
		"keeps the transcript and asks for a new snapshot when a patch invalidates $field",
		async ({ ops }) => {
			const socket = new TestSocket();
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const session = yield* openPiSession(() => socket);
						socket.receive(snapshot(5 as EntryId));
						yield* waitFor(session.changes, (state) => state.transcriptStatus === "synced");

						socket.receive({ type: "ops", session: "1", ops });
						const syncing = yield* waitFor(
							session.changes,
							(state) => state.transcriptStatus === "syncing",
						);
						expect(syncing).toMatchObject({
							value: { status: "open", messages: [{ parts: [{ text: "Note 5" }] }] },
						});
						yield* Effect.promise(() =>
							expect
								.poll(() => socket.sent)
								.toEqual([{ type: "watch" }, { type: "watch", from: 6 }]),
						);
						socket.receive(snapshot(6 as EntryId, 5 as EntryId));
						const restored = yield* waitFor(
							session.changes,
							(state) => state.transcriptStatus === "synced",
						);
						expect(restored).toMatchObject({
							value: {
								messages: [{ parts: [{ text: "Note 5" }] }, { parts: [{ text: "Note 6" }] }],
							},
						});
					}),
				),
			);
		},
	);

	it("preserves additional Pi fields when validating snapshots and history pages", () => {
		const frame = snapshot(5 as EntryId, 4 as EntryId);
		const entry = { ...frame.view.entries[0], data: { extensionField: "kept" } };
		const view = {
			...frame.view,
			entries: [entry],
			docs: { "pi.inbox": { items: [], otherField: true }, "custom.doc": { value: "kept" } },
		};
		const snapshotFrame = { ...frame, view };
		const page = { items: [entry] };
		expect(decodeServerMessage(JSON.stringify(snapshotFrame))).toMatchObject({
			_tag: "Some",
			value: snapshotFrame,
		});
		expect(decodeEntriesPage(page)).toMatchObject({ _tag: "Some", value: page });
	});

	it("lets a late receipt confirm an older submission without changing the latest draft", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive(snapshot(1 as EntryId));
					yield* waitFor(session.changes, (state) => state.transcriptStatus === "synced");
					const latestDraft = { text: "latest" };
					session.dispatch({ type: "submit", draft: { text: "older" } });
					session.dispatch({ type: "submit", draft: latestDraft });
					yield* waitFor(session.changes, (state) => state.submission?.draft === latestDraft);
					const [older, latest] = socket.sent.filter((frame) => frame.type === "submit");
					socket.acknowledge(latest!);
					yield* waitFor(session.changes, (state) => state.submission?.status === "accepted");

					yield* TestClock.adjust("10 seconds");
					const unconfirmed = yield* waitFor(
						session.changes,
						(state) => state.unconfirmedSubmissions.length === 1,
					);
					expect(unconfirmed).toMatchObject({ value: { unconfirmedSubmissions: [older] } });
					expect(socket.sent.slice(1)).toEqual([older, latest, older]);

					socket.acknowledge(older!, false);
					const confirmed = yield* waitFor(
						session.changes,
						(state) => state.unconfirmedSubmissions.length === 0,
					);
					expect(confirmed).toMatchObject({
						value: { submission: { draft: latestDraft, status: "accepted" } },
					});
				}),
			).pipe(Effect.provide(TestClock.layer())),
		);
	});

	it("processes commands during paging and matches receipts to the latest draft", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive(snapshot(5 as EntryId, 4 as EntryId));
					yield* waitFor(session.changes, (state) => state.earlier);
					session.dispatch({ type: "loadEarlier" });
					const page = yield* pageRequest(socket, 0);

					const firstDraft = { text: "first draft" };
					const secondDraft = { text: " second draft " };
					session.dispatch({ type: "submit", draft: firstDraft });
					session.dispatch({ type: "submit", draft: firstDraft });
					session.dispatch({ type: "submit", draft: secondDraft, whenBusy: "steer" });
					yield* waitFor(session.changes, (state) => state.submission?.draft === secondDraft);
					const submissions = socket.sent.filter((frame) => frame.type === "submit");
					expect(submissions.map((frame) => frame.input)).toEqual(["first draft", "second draft"]);
					expect(submissions[1]?.whenBusy).toBe("steer");

					socket.acknowledge(submissions[0]!);
					socket.receive({ type: "result", id: page.id, result: { items: [] } });
					const loaded = yield* waitFor(session.changes, (state) => !state.loading);
					expect(loaded).toMatchObject({
						value: { submission: { status: "pending", draft: secondDraft } },
					});

					socket.receive({ type: "error", id: submissions[1]!.id, message: "Prompt rejected" });
					const rejected = yield* waitFor(
						session.changes,
						(state) => state.submission?.status === "rejected",
					);
					expect(rejected).toMatchObject({
						value: { submission: { draft: secondDraft, message: "Prompt rejected" } },
					});
				}),
			),
		);
	});

	it("clears loading when sending a history request fails, then loads the page on retry", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive(snapshot(5 as EntryId, 4 as EntryId));
					yield* waitFor(session.changes, (state) => state.earlier);
					vi.spyOn(socket, "send").mockImplementationOnce(() => {
						throw new Error("Socket send failed");
					});

					session.dispatch({ type: "loadEarlier" });
					const failed = yield* waitFor(
						session.changes,
						(state) => !state.loading && state.historyError !== null,
					);
					expect(failed).toMatchObject({
						value: { status: "open", historyError: "Could not request messages. Try again." },
					});

					session.dispatch({ type: "loadEarlier" });
					const current = yield* pageRequest(socket, 0);
					socket.receive({
						type: "result",
						id: current.id,
						result: { items: snapshot(4 as EntryId).view.entries },
					});
					const loaded = yield* waitFor(session.changes, (state) => !state.loading);
					expect(loaded).toMatchObject({
						value: {
							historyError: null,
							messages: [{ parts: [{ text: "Note 4" }] }, { parts: [{ text: "Note 5" }] }],
						},
					});
				}),
			),
		);
	});

	it("times out a history page on the session clock and ignores its late replies during a retry", async () => {
		const socket = new TestSocket();
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* openPiSession(() => socket);
					socket.receive(snapshot(5 as EntryId, 4 as EntryId));
					yield* waitFor(session.changes, (state) => state.earlier);

					session.dispatch({ type: "loadEarlier" });
					const expired = yield* pageRequest(socket, 0);
					yield* TestClock.adjust("14 seconds");
					expect(yield* Stream.runHead(session.changes)).toMatchObject({
						value: { loading: true, historyError: null },
					});
					yield* TestClock.adjust("1 second");
					const timedOut = yield* TestClock.withLive(
						waitFor(session.changes, (state) => !state.loading && state.historyError !== null),
					);
					expect(timedOut).toMatchObject({
						value: {
							status: "open",
							loading: false,
							historyError: "Loading messages timed out. Try again.",
						},
					});

					session.dispatch({ type: "loadEarlier" });
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
					const loaded = yield* waitFor(
						session.changes,
						(state) => !state.loading && state.messages.length === 2,
					);
					expect(loaded).toMatchObject({
						value: {
							loading: false,
							historyError: null,
							messages: [{ parts: [{ text: "Note 4" }] }, { parts: [{ text: "Note 5" }] }],
						},
					});
				}),
			).pipe(Effect.provide(TestClock.layer())),
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
					session.dispatch({ type: "loadEarlier" });
					yield* pageRequest(socket, 0);
					socket.close();
					const closed = yield* waitFor(
						session.changes,
						(state) => state.status === "closed" && !state.loading,
					);
					expect(closed).toMatchObject({
						value: { status: "closed", loading: false, historyError: null },
					});

					socket.reconnect();
					socket.receive(snapshot(5 as EntryId, 4 as EntryId));
					yield* waitFor(session.changes, (state) => state.transcriptStatus === "synced");
					session.dispatch({ type: "loadEarlier" });
					const current = yield* pageRequest(socket, 1);
					const [entry] = snapshot(4 as EntryId).view.entries;
					socket.receive({
						type: "result",
						id: current.id,
						result: {
							items: [
								{
									...entry,
									model: [{ role: "assistant", timestamp: 0, stopReason: "stop", content: [null] }],
								},
							],
						},
					});
					const failed = yield* waitFor(
						session.changes,
						(state) => !state.loading && state.historyError !== null,
					);
					expect(failed).toMatchObject({
						value: { status: "open", loading: false, historyError: "Invalid history page" },
					});
					session.dispatch({ type: "loadEarlier" });
					const retry = yield* pageRequest(socket, 2);
					socket.receive({ type: "result", id: retry.id, result: { items: [entry] } });
					const loaded = yield* waitFor(
						session.changes,
						(state) => !state.loading && state.messages.length === 2,
					);
					expect(loaded).toMatchObject({
						value: {
							historyError: null,
							messages: [{ parts: [{ text: "Note 4" }] }, { parts: [{ text: "Note 5" }] }],
						},
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

					oldSession.dispatch({ type: "loadEarlier" });
					yield* waitFor(oldSession.changes, (state) => state.loading);
					yield* pageRequest(oldSocket, 0);

					yield* Scope.close(oldScope, Exit.void);
					expect(oldSession.dispatch({ type: "submit", draft: { text: "old session" } })).toBe(
						false,
					);
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
