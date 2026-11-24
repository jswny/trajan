import { setTimeout } from "node:timers/promises";
import { TurnSubmission } from "@trajan/harness";
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

test("keeps browser memory bounded while waiting for a model reply", async ({ context, page }) => {
	const composer = await openChat(page);
	const devtools = await context.newCDPSession(page);
	await page.request.post(`${control}/pause`);
	await composer.fill("hello");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText("Wrote", { exact: true })).toBeVisible();
	await devtools.send("HeapProfiler.collectGarbage");
	const before = await devtools.send("Runtime.getHeapUsage");
	await setTimeout(1000);
	await devtools.send("HeapProfiler.collectGarbage");
	const after = await devtools.send("Runtime.getHeapUsage");
	expect(after.usedSize - before.usedSize).toBeLessThan(32 * 1024 * 1024);
	await page.request.post(`${control}/release`);
	await expect(transcript.getByText('Wrote "hello"', { exact: true })).toBeVisible();
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

test("recovers a running exec without repeating its write", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Interrupt after writing.");
	await composer.press("Enter");
	await expect(page.getByText("Running exec", { exact: true })).toBeVisible();
	const activity = page.getByRole("list", { name: "Recent tool calls" });
	await expect(activity.getByRole("listitem").filter({ hasText: /write.*Succeeded/ })).toHaveCount(
		1,
	);
	await page.reload();
	await expect(activity.getByRole("listitem").filter({ hasText: /write.*Succeeded/ })).toHaveCount(
		1,
	);
	await expect
		.poll(async () => {
			const response = await page.request.post(`${control}/state`);
			return Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(await response.json())
				.text;
		})
		.toBe("once");

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	const transcript = page.getByRole("main");
	await expect(transcript.getByText('Wrote "once"', { exact: true })).toHaveCount(1);
	await expect(activity).toBeHidden();
	await transcript.getByText("Done", { exact: true }).click();
	await expect(activity.getByRole("listitem").filter({ hasText: /write.*Succeeded/ })).toHaveCount(
		1,
	);
	await composer.fill("hello");
	await composer.press("Enter");
	await expect(transcript.getByText('Wrote "oncehello"', { exact: true })).toBeVisible();
});

test("shows live tool progress and the final answer after replaying a read-only exec", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay`)).status()).toBe(204);
	await composer.fill("Replay two reads.");
	await composer.press("Enter");
	const calls = page.getByRole("list", { name: "Recent tool calls" }).getByRole("listitem");
	await expect(calls).toHaveText([/read_first.*Succeeded/, /read_second.*Running/]);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await expect(calls).toHaveText([/read_first.*Succeeded/, /read_second.*Running/]);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);

	const transcript = page.getByRole("main");
	await expect(transcript.getByText('Read ["first","second"]', { exact: true })).toHaveCount(1);
	await transcript.getByText("Done", { exact: true }).click();
	await expect(calls).toHaveText([/read_first.*Succeeded/, /read_second.*Succeeded/]);
});

test("restores compacted model context and completes exec after a restart", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Prepare the compacted reference.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText("Reference saved.", { exact: true })).toBeVisible();

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.getByText("Live", { exact: true })).toBeVisible();
	await composer.fill("Recall the compacted reference and save it using exec.");
	await composer.press("Enter");
	await expect(transcript.getByText("Saved amber-heron-795.", { exact: true })).toBeVisible();
	await transcript.getByText("Done", { exact: true }).click();
	await expect(transcript.getByRole("list", { name: "Recent tool calls" })).toContainText("write");
});

test("replays time and randomness when reopening a file after a restart", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay`)).status()).toBe(204);
	await composer.fill("Recover a file named with time and randomness.");
	await composer.press("Enter");
	const calls = page.getByRole("list", { name: "Recent tool calls" }).getByRole("listitem");
	await expect(calls).toHaveText([
		/runtime\.now.*Succeeded/,
		/runtime\.randomUUID.*Succeeded/,
		/runtime\.random.*Succeeded/,
		/write.*Succeeded/,
		/read_second.*Running/,
	]);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(calls.last()).toHaveText(/read_second.*Running/);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);

	const transcript = page.getByRole("main");
	await expect(transcript.getByText(/^Wrote "\/workspace\/\d+-[a-f0-9-]{36}\.txt"$/)).toHaveCount(
		1,
	);
	await transcript.getByText("Done", { exact: true }).click();
	await expect(calls.last()).toHaveText(/^read.*Succeeded/);
});

test("replay shows the interrupted stock edit and finishes without editing the file again", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay-edit`)).status()).toBe(204);
	await composer.fill("Recover an interrupted edit.");
	await composer.press("Enter");
	const calls = page.getByRole("list", { name: "Recent tool calls" }).getByRole("listitem");
	await expect(calls.last()).toHaveText(/edit.*Running/);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	const transcript = page.getByRole("main");
	await expect(
		transcript.getByText(/Recovered .*"edit":"interrupted".*"text":"seed!"/),
	).toHaveCount(1);
	await transcript.getByText("Done", { exact: true }).click();
	await expect(calls.filter({ hasText: /edit.*Interrupted/ })).toBeVisible();
	await expect(calls.last()).toHaveText(/read.*Succeeded/);
});

test("replay shows the interrupted Git call and a successful status check", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay-git`)).status()).toBe(204);
	await composer.fill("Recover interrupted Git branch creation.");
	await composer.press("Enter");
	const decodeState = Schema.decodeUnknownSync(
		Schema.Struct({ pausedAt: Schema.optionalKey(Schema.String) }),
	);
	await expect
		.poll(async () => {
			const response = await page.request.post(`${control}/state`);
			return decodeState(await response.json()).pausedAt;
		})
		.toBe("during-replay-git");

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	const transcript = page.getByRole("main");
	await expect(transcript.getByText(/^Recovered .*"branchExists":true/)).toHaveCount(1);
	await transcript.getByText("Done", { exact: true }).click();
	const calls = transcript.getByRole("list", { name: "Recent tool calls" }).getByRole("listitem");
	await expect(calls.filter({ hasText: /git\.branch.*Interrupted/ })).toHaveCount(1);
	await expect(calls.filter({ hasText: /git\.status.*Succeeded/ })).toBeVisible();
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
	await page.reload();
	await expect(page.getByRole("main").getByText("Remember first", { exact: true })).toBeVisible();
	await expect(page.getByRole("main").getByText("Stopped", { exact: true })).toBeVisible();
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

test("keeps separate outcomes for concurrent calls to the same tool", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Run a workspace module.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText("Done", { exact: true })).toBeVisible();
	await expect(transcript.getByText(/Wrote .*42/)).toBeVisible();
	await page.reload();
	await transcript.getByText("Done", { exact: true }).click();
	const calls = transcript.getByRole("list", { name: "Recent tool calls" }).getByRole("listitem");
	await expect(calls).toHaveCount(3);
	await expect(calls.filter({ hasText: /write.*Succeeded/ })).toBeVisible();
	await expect(calls.filter({ hasText: /read.*Succeeded/ })).toBeVisible();
	await expect(calls.filter({ hasText: /read.*Failed/ })).toBeVisible();
});

test("warns about a partial Code Mode outcome when a script fails after writing", async ({
	page,
}) => {
	const composer = await openChat(page);
	await composer.fill("Fail Code Mode after a write.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(
		transcript.getByText(/Inspect it before repeating the action/).first(),
	).toBeVisible();
	await composer.fill("hello");
	await composer.press("Enter");
	await expect(transcript.getByText('Wrote "writtenhello"', { exact: true })).toBeVisible();
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
	await expect(dialog.getByText("exec", { exact: true })).toBeVisible();
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
