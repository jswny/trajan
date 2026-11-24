import { TurnSubmission } from "@trajan/effect-harness";
import { devices, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { ChatEvent, ChatPath, ChatReceipt } from "../../effect-harness/chat-protocol";

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ChatEvent));
const decodeSubmission = Schema.decodeUnknownSync(Schema.fromJsonString(TurnSubmission));
const decodeReceipt = Schema.decodeUnknownSync(ChatReceipt);
const control = "/__browser-smoke/effect-stream";

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: "trajan-fixture", value: crypto.randomUUID(), url: baseURL!, httpOnly: true },
	]);
});

async function openChat(page: Page) {
	await page.goto("/");
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	return page.getByRole("textbox", { name: "Message Trajan" });
}

test("does not send while the initial snapshot is missing", async ({ page }) => {
	let deliver: (() => void) | undefined;
	await page.routeWebSocket("**/api/chat/live", (client) => {
		const server = client.connectToServer();
		server.onMessage((data) => {
			const frame = decodeFrame(String(data));
			if (frame._tag === "Some" && frame.value.type === "snapshot" && deliver === undefined) {
				deliver = () => client.send(data);
			} else {
				client.send(data);
			}
		});
	});
	await page.goto("/");
	const composer = page.getByRole("textbox", { name: "Message Trajan" });
	await composer.fill("Remember milk");
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	await expect.poll(() => deliver !== undefined).toBe(true);
	deliver?.();
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
});

test("retries an uncorrelated receipt with the same operation ID and preserves a newer draft", async ({
	page,
}) => {
	const requests: Array<typeof TurnSubmission.Type> = [];
	let sendDuplicate: (() => Promise<void>) | undefined;
	await page.route("**/api/chat", async (route) => {
		const submission = decodeSubmission(route.request().postData());
		requests.push(submission);
		const response = await route.fetch();
		if (requests.length === 1) {
			const receipt = decodeReceipt(await response.json());
			await route.fulfill({
				status: response.status(),
				json: { ...receipt, submissionId: "different" },
			});
		} else {
			sendDuplicate = () => route.fulfill({ response });
		}
	});
	const composer = await openChat(page);
	await composer.fill("Remember milk");
	await composer.press("Enter");
	await expect.poll(() => sendDuplicate !== undefined).toBe(true);
	await composer.fill("newer draft");
	await sendDuplicate?.();
	await expect(page.locator("form")).toHaveAttribute("aria-busy", "false");
	expect(requests).toHaveLength(2);
	expect(requests[0]).toEqual(requests[1]);
	await expect(composer).toHaveValue("newer draft");
	await expect(page.getByRole("main").getByText("Remember milk", { exact: true })).toHaveCount(1);
});

test("restores an interrupted stream into the chat without repeating the tool", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await composer.fill("hello");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText("Wrote", { exact: true })).toBeVisible();
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await expect(transcript.getByText("Wrote", { exact: true })).toHaveCount(1);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(transcript.getByText('Wrote "hello"', { exact: true })).toHaveCount(1);
	await expect(transcript.getByText("hello", { exact: true })).toHaveCount(1);
	await page.reload();
	await expect(transcript.getByText('Wrote "hello"', { exact: true })).toHaveCount(1);
});

test("stops the active reply and continues a follow-up submitted from another tab", async ({
	page,
	context,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await composer.fill("Remember first");
	await composer.press("Enter");
	const other = await context.newPage();
	const followUp = await openChat(other);
	await followUp.fill("Remember next");
	await other.getByRole("button", { name: "Queue follow-up" }).click();
	await expect(page.getByText("1 queued behind this run")).toBeVisible();
	await page.getByRole("button", { name: "Stop" }).click();
	await expect(page.getByRole("main").getByText("Remember next", { exact: true })).toBeVisible();
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(other.getByRole("main").getByText("Remembering next", { exact: true })).toHaveCount(
		1,
	);
	await expect(page.getByRole("main").getByText("Remembering first", { exact: true })).toHaveCount(
		0,
	);
});

test("loads older messages without replacing the recent transcript", async ({ page }) => {
	for (let index = 0; index < 26; index++) {
		const response = await page.request.post(ChatPath, {
			data: { id: `history-${index}`, prompt: `Remember page ${index}` },
		});
		expect(response.status()).toBe(202);
	}
	await openChat(page);
	const transcript = page.getByRole("main");
	await expect(transcript.getByText("Remembering page 25", { exact: true })).toBeVisible();
	await expect(transcript.getByText("Remembering page 0", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Load earlier messages" }).click();
	await expect(transcript.getByText("Remembering page 0", { exact: true })).toHaveCount(1);
	await expect(transcript.getByText("Remembering page 25", { exact: true })).toHaveCount(1);
});

test("shows a Code Mode result from a real sandbox and workspace module", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Run a workspace module.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText("Done", { exact: true })).toBeVisible();
	await expect(transcript.getByText(/Wrote .*42/)).toBeVisible();
});

test("keeps the transcript height and restores focus on a short iPhone viewport", async ({
	page,
}) => {
	await page.setViewportSize({ ...devices["iPhone 17 Pro"].viewport, height: 352 });
	await openChat(page);
	const tools = page.getByRole("button", { name: "Tools", exact: true });
	const dialog = page.getByRole("dialog", { name: "Tools" });
	const close = dialog.getByRole("button", { name: "Close tools" });
	const transcript = page.locator("main");
	const height = await transcript.evaluate((el) => el.clientHeight);
	await tools.click();
	await expect(dialog.getByText("append", { exact: true })).toBeVisible();
	expect(await transcript.evaluate((el) => el.clientHeight)).toBe(height);
	await expect.poll(() => close.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(44);
	await close.click();
	await expect(dialog).toBeHidden();
	await expect(tools).toBeFocused();
});

test("wraps a long prompt and keeps a wide code block scrollable inside the transcript", async ({
	page,
}) => {
	const composer = await openChat(page);
	await composer.fill(`Remember ${"x".repeat(180)}`);
	await composer.press("Enter");
	await expect(page.getByRole("main").getByText(/Remembering x+/)).toBeVisible();
	await composer.fill("Show wide code");
	await composer.press("Enter");
	const block = page.locator('[data-markdown="code-block"] pre');
	await expect(block).toBeVisible();
	await expect.poll(() => block.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
	expect(await page.locator("main").evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
});
