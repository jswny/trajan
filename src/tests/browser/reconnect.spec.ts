import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
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
