import { expect, test } from "vite-plus/test";
import { INITIAL_CHAT, mergeChatPage, receiveChatEvent } from "../chat-session";

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

test("ignores stale deltas and replaces a discarded draft after a new snapshot", () => {
	const base = {
		type: "snapshot" as const,
		page: { entries: [], nextBefore: null },
		queued: 0,
		catalog: [],
	};
	const first = receiveChatEvent(INITIAL_CHAT, {
		...base,
		active: { runId: "first", submissionId: "a", state: "running", prompt: "hello" },
		preview: { runId: "first", text: "partial", tool: null, activity: [] },
	});
	const second = receiveChatEvent(first, {
		...base,
		active: { runId: "second", submissionId: "b", state: "running", prompt: "again" },
		preview: { runId: "second", text: "fresh", tool: null, activity: [] },
	});
	expect(receiveChatEvent(second, { type: "text-delta", runId: "first", text: "stale" })).toBe(
		second,
	);
	expect(second.preview?.text).toBe("fresh");
});
