import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { createLiveBrowser } from "../live-browser";

const url = "https://live.browser.run/ui/view?mode=tab&wss=fixture";

test.each([
	{ mode: "readonly", expected: 200, status: "open" },
	{ mode: "unguarded", expected: 502, status: undefined },
	{ mode: "replaced", expected: 200, status: "closed" },
] as const)("handles a $mode Live View lease", async ({ mode, expected, status }) => {
	const stub = env.CHAT_TEST.getByName(crypto.randomUUID());
	const reply = await runInDurableObject(stub, async (_, { storage }) => {
		const getLiveView = vi.fn<Env["BROWSER"]["getLiveView"]>(async () => {
			if (mode === "replaced") {
				await Effect.runPromise(live.changeAvailability("reopened"));
			}
			return {
				id: "lease",
				devtoolsFrontendUrl: url,
				webSocketDebuggerUrl: "wss://browser.invalid",
				options: {
					mode: "tab",
					...(mode !== "unguarded" && { guardrails: { mode: "readonly" } }),
				},
			};
		});
		const live = createLiveBrowser(
			storage,
			{
				liveView: () =>
					Promise.resolve({
						sessionId: "session",
						expiresInMs: 60_000,
						targets: [{ type: "page", targetId: "tab", url, pageUrl: "https://example.com/" }],
					}),
			},
			{ getLiveView },
			() => {},
		);
		await Effect.runPromise(live.changeAvailability("open"));
		const response = await Effect.runPromise(
			live.requestView(
				new Request("https://trajan.invalid/api/chat/browser-view", {
					method: "POST",
					body: JSON.stringify({ id: live.watch()?.id }),
				}),
			),
		);
		const payload: unknown = response.ok ? await response.json() : undefined;
		return {
			status: response.status,
			cache: response.headers.get("Cache-Control"),
			payload,
			request: getLiveView.mock.calls[0],
		};
	});
	expect(reply.status).toBe(expected);
	expect(reply.cache).toBe("no-store");
	expect(reply.request).toEqual([
		"session",
		{ targetId: "tab", mode: "tab", expiresInMs: 60_000, guardrails: { mode: "readonly" } },
	]);
	if (status === undefined) {
		expect(reply.payload).toBeUndefined();
	} else {
		expect(reply.payload).toMatchObject({ status, ...(status === "open" && { url }) });
	}
});
