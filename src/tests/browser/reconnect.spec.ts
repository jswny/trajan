import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { PiClientMessage, PiServerMessage } from "../../protocol";

const workerLog = new URL("../../../.cloudflare/browser-smoke.log", import.meta.url);

test("ignores invalid receipts, then replays the pending submit once", async ({
	page,
	request,
}) => {
	const prompt = "gate browser recovery";
	const submissions: Array<Extract<PiClientMessage, { type: "submit" }>> = [];
	const receipts: Array<Extract<PiServerMessage, { type: "result" }>> = [];
	let sessionId: string | undefined;

	await page.routeWebSocket(/\/agents\/trajan\//, (client) => {
		const server = client.connectToServer();
		client.onMessage((data) => {
			const message = JSON.parse(String(data)) as PiClientMessage;
			if (message.type === "submit") submissions.push(message);
			server.send(data);
		});
		server.onMessage((data) => {
			const message = JSON.parse(String(data)) as PiServerMessage;
			if (message.type === "result" && message.id === submissions[0]?.id) {
				receipts.push(message);
				if (receipts.length === 1) {
					// Replace Pi's real receipt with invalid frames that carry the right request ID.
					sessionId = new URL(client.url()).pathname.split("/").at(-1);
					client.send(JSON.stringify({ ...message, result: null }));
					client.send(
						JSON.stringify({
							...message,
							result: { accepted: true, operationId: "another-operation", session: "1" },
						}),
					);
					// A visible marker confirms that the client has processed both preceding frames.
					client.send(
						JSON.stringify({
							type: "hello",
							session: "1",
							tools: [{ name: "receipt-test-marker", description: "Test marker" }],
						}),
					);
					return;
				}
			}
			client.send(data);
		});
	});

	await page.goto("/");
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	const composer = page.getByRole("textbox", { name: "Message Trajan" });
	await composer.fill(prompt);
	await composer.press("Enter");
	await expect.poll(() => receipts[0]?.result).toMatchObject({ accepted: true });
	await expect(page.getByText("receipt-test-marker", { exact: true })).toBeVisible();
	await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
	await expect(composer).toHaveValue(prompt);

	// The newer revision deliberately ends up with the same text as the original.
	await composer.fill("A newer draft");
	await composer.fill(prompt);
	if (!sessionId) throw new Error("Missing session for the intercepted receipt");
	expect((await request.post(`/__browser-smoke/${sessionId}/disconnect`)).status()).toBe(204);
	await expect.poll(() => receipts[1]?.result).toMatchObject({ accepted: false });
	expect(submissions).toHaveLength(2);
	expect(submissions[1]).toEqual(submissions[0]);
	expect(submissions[0]?.operationId).toBe(submissions[0]?.id);

	const release = await request.post(`/__browser-smoke/${sessionId}/release`);
	expect(release.status()).toBe(204);
	const transcript = page.getByRole("main");
	await expect(
		transcript.getByText("tool said: released after 1 runs", { exact: true }),
	).toBeVisible();
	await expect(transcript.getByText(prompt, { exact: true })).toHaveCount(1);
	await expect(composer).toHaveValue(prompt);
	await expect(page.getByText("Live", { exact: true })).toBeVisible();

	await expect
		.poll(async () => {
			const log = await readFile(workerLog, "utf8");
			const events = log.match(/^\{\r?\n\s*message: 'pi_session_watch',[\s\S]*?^\}/gm) ?? [];
			return events.filter(
				(event) =>
					event.includes("trigger: 'client_request'") && event.includes("outcome: 'started'"),
			).length;
		})
		.toBe(2);
});

for (const lostReceipts of [1, 2]) {
	test(`recovers on the same socket when ${lostReceipts === 1 ? "the first receipt is" : "both receipts are"} lost`, async ({
		page,
		request,
	}) => {
		const prompt = "gate browser recovery";
		const submissions: Array<Extract<PiClientMessage, { type: "submit" }>> = [];
		const receipts: Array<Extract<PiServerMessage, { type: "result" }>> = [];
		const connections: string[] = [];
		await page.clock.install();
		await page.routeWebSocket(/\/agents\/trajan\//, (client) => {
			connections.push(client.url());
			const server = client.connectToServer();
			client.onMessage((data) => {
				const message = JSON.parse(String(data)) as PiClientMessage;
				if (message.type === "submit") submissions.push(message);
				server.send(data);
			});
			server.onMessage((data) => {
				const message = JSON.parse(String(data)) as PiServerMessage;
				if (message.type === "result" && message.id === submissions[0]?.id) {
					receipts.push(message);
					if (receipts.length <= lostReceipts) return;
				}
				client.send(data);
			});
		});

		await page.goto("/");
		await expect(page.getByText("Live", { exact: true })).toBeVisible();
		const composer = page.getByRole("textbox", { name: "Message Trajan" });
		await composer.fill(prompt);
		await composer.press("Enter");
		await expect.poll(() => receipts[0]?.result).toMatchObject({ accepted: true });
		await expect(page.locator("form")).toHaveAttribute("aria-busy", "true");
		await page.clock.fastForward(6_000);
		await expect.poll(() => receipts[1]?.result).toMatchObject({ accepted: false });

		const retry = page.getByRole("button", { name: "Retry sending" });
		if (lostReceipts === 2) {
			await page.clock.fastForward(6_000);
			await expect(retry).toBeVisible();
			await expect(page.locator("form")).toHaveAttribute("aria-busy", "false");
			await expect(composer).toHaveValue(prompt);
			await composer.press("Enter");
			await page.clock.fastForward(6_000);
			expect(submissions).toHaveLength(2);
			await retry.click();
			await expect.poll(() => receipts[2]?.result).toMatchObject({ accepted: false });
		}

		await expect(composer).toHaveValue("");
		await expect(retry).toHaveCount(0);
		await expect(page.locator("form")).toHaveAttribute("aria-busy", "false");
		await page.clock.fastForward(6_000);
		expect(submissions).toEqual(Array.from({ length: lostReceipts + 1 }, () => submissions[0]));
		expect(connections).toHaveLength(1);

		const sessionId = new URL(connections[0]!).pathname.split("/").at(-1);
		const release = await request.post(`/__browser-smoke/${sessionId}/release`);
		expect(release.status()).toBe(204);
		const transcript = page.getByRole("main");
		await expect(
			transcript.getByText("tool said: released after 1 runs", { exact: true }),
		).toBeVisible();
		await expect(transcript.getByText(prompt, { exact: true })).toHaveCount(1);
	});
}

async function dropWatchSnapshots(page: Page, dropped: readonly number[]) {
	const connections: string[] = [];
	const watches: Array<Extract<PiClientMessage, { type: "watch" }>> = [];
	const snapshots: Array<Extract<PiServerMessage, { type: "view" }>> = [];
	await page.routeWebSocket(/\/agents\/trajan\//, (client) => {
		connections.push(client.url());
		const server = client.connectToServer();
		client.onMessage((data) => {
			const message = JSON.parse(String(data)) as PiClientMessage;
			if (message.type === "watch") watches.push(message);
			server.send(data);
		});
		server.onMessage((data) => {
			const message = JSON.parse(String(data)) as PiServerMessage;
			if (message.type === "view") {
				snapshots.push(message);
				if (dropped.includes(snapshots.length)) return;
			}
			client.send(data);
		});
	});
	return { connections, watches, snapshots };
}

test("waits for a snapshot before going Live and retries the watch on the same socket", async ({
	page,
}) => {
	await page.clock.install();
	const { connections, watches, snapshots } = await dropWatchSnapshots(page, [1]);
	await page.goto("/");
	await expect.poll(() => snapshots.length).toBe(1);
	await expect(page.getByText("Syncing", { exact: true })).toBeVisible();
	await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
	const composer = page.getByRole("textbox", { name: "Message Trajan" });
	await composer.fill("Draft while syncing");
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();

	await page.clock.fastForward(6_000);
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
	await expect(composer).toHaveValue("Draft while syncing");
	await page.clock.fastForward(12_000);
	expect(connections).toHaveLength(1);
	expect(watches).toEqual([{ type: "watch" }, { type: "watch" }]);
});

test("retries an invalid snapshot before making its transcript visible", async ({ page }) => {
	await page.clock.install();
	let snapshots = 0;
	await page.routeWebSocket(/\/agents\/trajan\//, (client) => {
		const server = client.connectToServer();
		server.onMessage((data) => {
			const message = JSON.parse(String(data)) as PiServerMessage;
			if (message.type === "view" && ++snapshots === 1) {
				const { view } = message;
				client.send(
					JSON.stringify({
						...message,
						view: {
							...view,
							entries: [
								...view.entries,
								{
									id: 1234,
									conversationId: view.conversation.id,
									kind: "test.note",
									model: [{ role: "user", timestamp: 0, content: "Malformed snapshot entry" }],
								},
							],
							docs: { ...view.docs, "pi.inbox": {} },
						},
					}),
				);
				return;
			}
			client.send(data);
		});
	});
	await page.goto("/");
	await expect.poll(() => snapshots).toBe(1);
	await expect(page.getByText("Syncing", { exact: true })).toBeVisible();
	await page.clock.fastForward(6_000);
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await expect(page.getByText("Malformed snapshot entry", { exact: true })).toHaveCount(0);
	expect(snapshots).toBe(2);
});

test("keeps the transcript and offers manual sync after two snapshots go missing on reconnect", async ({
	page,
	request,
}) => {
	await page.clock.install();
	const { connections, watches, snapshots } = await dropWatchSnapshots(page, [2, 3]);
	await page.goto("/");
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	const composer = page.getByRole("textbox", { name: "Message Trajan" });
	await composer.fill("Keep this transcript");
	await composer.press("Enter");
	const answer = page.getByText("echo: Keep this transcript", { exact: true });
	await expect(answer).toBeVisible();

	const sessionId = new URL(connections[0]!).pathname.split("/").at(-1);
	expect((await request.post(`/__browser-smoke/${sessionId}/disconnect`)).status()).toBe(204);
	await expect.poll(() => snapshots.length).toBe(2);
	await expect(page.getByText("Syncing", { exact: true })).toBeVisible();
	await expect(answer).toBeVisible();
	await page.clock.fastForward(6_000);
	await expect.poll(() => snapshots.length).toBe(3);
	await page.clock.fastForward(6_000);
	const retry = page.getByRole("button", { name: "Retry sync" });
	await expect(retry).toBeVisible();
	await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
	await expect(answer).toBeVisible();
	await page.clock.fastForward(12_000);
	expect(watches).toHaveLength(3);

	await retry.click();
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await expect(answer).toHaveCount(1);
	expect(connections).toHaveLength(2);
	expect(watches[1]?.from).toBeDefined();
	expect(watches.slice(2)).toEqual([watches[1], watches[1]]);
});

test("renders code while syntax highlighting loads and reuses it for later messages", async ({
	page,
}) => {
	const release = Promise.withResolvers<void>();
	let highlightRequests = 0;
	await page.route("**/src/markdown-highlights.ts*", async (route) => {
		highlightRequests += 1;
		await release.promise;
		await route.continue();
	});
	try {
		await page.goto("/");
		await expect(page.getByText("Live", { exact: true })).toBeVisible();
		expect(highlightRequests).toBe(0);
		const composer = page.getByRole("textbox", { name: "Message Trajan" });
		await composer.fill("Code example\n\n```javascript\nconst answer = 42;\n```");
		await composer.press("Enter");
		const code = page.locator("pre code").filter({ hasText: "const answer = 42;" });
		await expect(code).toBeVisible();
		await expect.poll(() => highlightRequests).toBe(1);
		release.resolve();
		await expect(code.locator("span[style]").first()).toBeVisible();

		await composer.fill("Another example\n\n```javascript\nconst next = 43;\n```");
		await composer.press("Enter");
		const next = page.locator("pre code").filter({ hasText: "const next = 43;" });
		await expect(next.locator("span[style]").first()).toBeVisible();
		expect(highlightRequests).toBe(1);
	} finally {
		release.resolve();
	}
});
