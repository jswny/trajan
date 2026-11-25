import { setTimeout } from "node:timers/promises";
import { TurnSubmission } from "@trajan/harness";
import { devices, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { ChatEvent, ChatPath, ChatReceipt } from "../../chat/protocol";

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ChatEvent));
const decodeSubmission = Schema.decodeUnknownSync(Schema.fromJsonString(TurnSubmission));
const decodeReceipt = Schema.decodeUnknownSync(ChatReceipt);
const control = "/__browser-smoke/chat";

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([
		{ name: "trajan-fixture", value: crypto.randomUUID(), url: baseURL!, httpOnly: true },
	]);
});

async function openChat(page: Page) {
	await page.goto("/");
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	return page.getByRole("textbox", { name: "Message Trajan" });
}

function toolCards(page: Page) {
	return page.getByRole("main").locator(":scope > details");
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
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
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
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	await expect(transcript.getByText("Wrote", { exact: true })).toHaveCount(1);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(transcript.getByText('Wrote "hello"', { exact: true })).toHaveCount(1);
	await expect(transcript.getByText("hello", { exact: true })).toHaveCount(1);
	await page.reload();
	await expect(transcript.getByText('Wrote "hello"', { exact: true })).toHaveCount(1);
});

test("shows animated progress with either motion preference", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const composer = await openChat(page);
	await composer.fill("Interrupt after writing.");
	await composer.press("Enter");
	const spinner = page.getByText("Running exec", { exact: true }).locator("svg");
	await expect(spinner).toHaveCSS("animation-name", "pulse");
	await expect(spinner).toHaveCSS("transform", "none");
	await expect
		.poll(() => spinner.evaluate((element) => Number(getComputedStyle(element).opacity)))
		.toBeLessThan(0.95);

	await page.emulateMedia({ reducedMotion: "no-preference" });
	await expect(spinner).toHaveCSS("animation-name", "spin");
	await expect(spinner).not.toHaveCSS("transform", "none");
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(spinner).toBeHidden();
});

test("recovers a running exec without repeating its write", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Interrupt after writing.");
	await composer.press("Enter");
	await expect(page.getByText("Running exec", { exact: true })).toBeVisible();
	await toolCards(page).last().locator(":scope > summary").click();
	const activity = page.getByRole("list", { name: "Recent tool calls" });
	await expect(activity.getByRole("listitem").filter({ hasText: /write.*Succeeded/ })).toHaveCount(
		1,
	);
	await page.reload();
	await toolCards(page).last().locator(":scope > summary").click();
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
	await expect(activity.getByRole("listitem").filter({ hasText: /write.*Succeeded/ })).toHaveCount(
		1,
	);
	await composer.fill("hello");
	await composer.press("Enter");
	await expect(transcript.getByText('Wrote "oncehello"', { exact: true })).toBeVisible();
});

test("keeps the same tool card open through recovery, streaming, and commit", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay`)).status()).toBe(204);
	await composer.fill("Replay two reads.");
	await composer.press("Enter");
	const card = toolCards(page).last();
	const summary = card.locator(":scope > summary");
	const calls = card.getByRole("list", { name: "Recent tool calls" }).getByRole("listitem");
	await summary.click();
	await expect(calls).toHaveText([/read_first.*Succeeded/, /read_second.*Running/]);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	await summary.click();
	await expect(calls).toHaveText([/read_first.*Succeeded/, /read_second.*Running/]);
	const pending = calls.last();
	await pending.locator("summary").click();
	await expect(pending.getByText("Arguments", { exact: true })).toBeVisible();
	await expect(pending.getByText("Result", { exact: true })).toHaveCount(0);
	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await expect(page.getByText("Responding", { exact: true })).toBeVisible();
	await expect(summary).toContainText("Done");
	await expect(pending.locator("pre").last()).toHaveText("second");
	await expect(card).toHaveAttribute("open");
	await expect(pending.locator("details")).toHaveAttribute("open");
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);

	const transcript = page.getByRole("main");
	await expect(transcript.getByText('Read ["first","second"]', { exact: true })).toHaveCount(1);
	await expect(toolCards(page)).toHaveCount(1);
	await expect(card).toHaveAttribute("open");
	await expect(pending.locator("details")).toHaveAttribute("open");
	await expect(calls).toHaveText([/read_first.*Succeeded/, /read_second.*Succeeded/]);
});

test("keeps completed exec cards visible while the model starts another tool", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-between-tools`)).status()).toBe(204);
	await composer.fill("Append hello, then world.");
	await composer.press("Enter");
	const cards = toolCards(page);
	const first = cards.first();
	await expect(first.locator(":scope > summary")).toHaveText("execDone");
	await expect(page.getByText("Waiting for the model", { exact: true })).toBeVisible();
	await expect(cards).toHaveCount(1);
	await first.locator(":scope > summary").click();
	await expect(first.locator("pre").first()).toHaveText('"hello"');

	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await expect(page.getByText("Responding", { exact: true })).toBeVisible();
	await expect(cards).toHaveCount(2);
	await expect(first).toHaveAttribute("open");
	await expect(cards.last().locator(":scope > summary")).toHaveText("execDone");
	await cards.last().locator(":scope > summary").click();
	await expect(cards.last().locator("pre").first()).toHaveText('"hello world"');

	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(
		page.getByRole("main").getByText('Wrote "hello world"', { exact: true }),
	).toBeVisible();
	await expect(cards).toHaveCount(2);
	await expect(first).toHaveAttribute("open");
	await expect(cards.last()).toHaveAttribute("open");
});

test("restores compacted model context and completes exec after a restart", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Prepare the compacted reference.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText("Reference saved.", { exact: true })).toBeVisible();

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
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
	await toolCards(page).last().locator(":scope > summary").click();
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
	await toolCards(page).last().locator(":scope > summary").click();
	await expect(calls.last()).toHaveText(/read_second.*Running/);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);

	const transcript = page.getByRole("main");
	await expect(transcript.getByText(/^Wrote "\/workspace\/\d+-[a-f0-9-]{36}\.txt"$/)).toHaveCount(
		1,
	);
	await expect(calls.last()).toHaveText(/^read.*Succeeded/);
});

test("replay shows the interrupted stock edit and finishes without editing the file again", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay-edit`)).status()).toBe(204);
	await composer.fill("Recover an interrupted edit.");
	await composer.press("Enter");
	await toolCards(page).last().locator(":scope > summary").click();
	const calls = page.getByRole("list", { name: "Recent tool calls" }).getByRole("listitem");
	await expect(calls.last()).toHaveText(/edit.*Running/);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	const transcript = page.getByRole("main");
	await expect(
		transcript.getByText(/Recovered .*"edit":"interrupted".*"text":"seed!"/),
	).toHaveCount(1);
	await transcript.getByText("Done", { exact: true }).click();
	const interrupted = calls.filter({ hasText: /edit.*Interrupted/ });
	await expect(interrupted).toBeVisible();
	await interrupted.locator("summary").press("Enter");
	await expect(interrupted.locator("pre")).toContainText('"newText": "seed!"');
	await expect(interrupted.getByText("Result", { exact: true })).toHaveCount(0);
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

test("runs a scheduled turn once across a restart with the chat closed", async ({
	page,
	context,
}) => {
	const composer = await openChat(page);
	await composer.fill("Schedule a workspace check.");
	await composer.press("Enter");
	await expect(page.getByRole("main").getByText(/^Scheduled \{/)).toBeVisible();
	await page.close();
	expect((await context.request.post(`${control}/crash`)).status()).toBe(500);
	// Leave the Worker with no chat connection while the alarm and its retry run.
	await setTimeout(4500);
	const history = await context.request.get(`${ChatPath}/history`);
	expect(history.ok()).toBe(true);
	expect(await history.text()).toContain("The scheduled workspace check ran.");
	const reopened = await context.newPage();
	await openChat(reopened);
	const transcript = reopened.getByRole("main");
	await expect(
		transcript.getByText("The scheduled workspace check ran.", { exact: true }),
	).toHaveCount(1);
	await reopened.reload();
	await expect(
		transcript.getByText("The scheduled workspace check ran.", { exact: true }),
	).toHaveCount(1);
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
	const found = calls.filter({ hasText: /read.*Succeeded/ });
	const missing = calls.filter({ hasText: /read.*Failed/ });
	await expect(found.locator("pre")).toHaveCount(0);
	await expect(missing.locator("pre")).toHaveCount(0);
	await found.locator("summary").click();
	await expect(found.locator("pre").nth(0)).toContainText("/workspace/module.txt");
	await expect(found.locator("pre").nth(1)).toContainText('"text": "hello"');
	await expect(missing.locator("pre")).toHaveCount(0);
	await missing.locator("summary").click();
	await expect(missing.locator("pre").nth(0)).toContainText("/workspace/missing.txt");
	await expect(missing.locator("pre").nth(1)).toContainText('"isError": true');
	await expect(found.locator("pre")).toHaveCount(2);
});

test("warns about a partial Code Mode outcome when a script fails after writing", async ({
	page,
}) => {
	const composer = await openChat(page);
	await composer.fill("Fail Code Mode after a write.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	const card = transcript.locator(":scope > details");
	await expect(card.locator(":scope > summary")).toHaveText("execOutcome unknown");
	await expect(
		transcript.getByText(/Inspect it before repeating the action/).filter({ visible: true }),
	).toBeVisible();
	await card.locator(":scope > summary").click();
	await expect(card.getByText(/Inspect it before repeating the action/)).toBeVisible();
	await composer.fill("hello");
	await composer.press("Enter");
	await expect(transcript.getByText('Wrote "writtenhello"', { exact: true })).toBeVisible();
});

test("changes the theme without moving the transcript on a short iPhone viewport", async ({
	page,
}) => {
	await page.setViewportSize({ ...devices["iPhone 17 Pro"].viewport, height: 352 });
	await openChat(page);
	const settings = page.getByRole("button", { name: "Chat settings" });
	const menu = page.getByRole("menu");
	const dark = menu.getByRole("menuitemradio", { name: "Dark" });
	const transcript = page.locator(".chat-transcript");
	const height = await transcript.evaluate((el) => el.clientHeight);
	await settings.press("Enter");
	await expect(menu.getByRole("menuitemradio", { name: "Auto" })).toBeChecked();
	expect(await transcript.evaluate((el) => el.clientHeight)).toBe(height);
	await expect.poll(() => dark.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(44);
	await dark.press("Enter");
	await expect(menu).toBeHidden();
	await expect(settings).toBeFocused();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

	await page.reload();
	await settings.click();
	await expect(dark).toBeChecked();
});

test("keeps the composer one row tall until the draft needs more space", async ({ page }) => {
	await page.setViewportSize({ ...devices["iPhone 17 Pro"].viewport, height: 352 });
	const composer = await openChat(page);
	const settings = page.getByRole("button", { name: "Chat settings" });
	const send = page.getByRole("button", { name: "Send message" });
	const composerHeight = () =>
		composer.evaluate((element) => element.parentElement?.getBoundingClientRect().height);
	const controlHeight = await settings.evaluate(
		(element) => element.getBoundingClientRect().height,
	);
	await expect.poll(composerHeight).toBe(controlHeight);
	await composer.fill("Remember the first line");
	await composer.press("Shift+Enter");
	await composer.pressSequentially("and the second");
	await expect(composer).toHaveValue("Remember the first line\nand the second");
	await expect.poll(composerHeight).toBeGreaterThan(controlHeight);
	await expect(send).toBeInViewport();

	await composer.press("Enter");
	await expect(page.getByRole("main")).toContainText("Remembering the first line");
	await expect.poll(composerHeight).toBe(controlHeight);
});

test("keeps the latest reply above a growing composer when following the transcript", async ({
	page,
}) => {
	const { viewport } = devices["iPhone 17 Pro"];
	await page.setViewportSize(viewport);
	const composer = await openChat(page);
	const scroller = page.locator(".chat-transcript");
	const latestReply = page.getByRole("main").getByText(/^Remembering a short example/);
	const distanceFromBottom = () =>
		scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
	const replyBottom = () =>
		latestReply.evaluate((element) => element.getBoundingClientRect().bottom);
	const composerTop = () =>
		composer.evaluate((element) => element.parentElement?.getBoundingClientRect().top ?? 0);
	const multilineDraft = "One line\nTwo lines\nThree lines\nFour lines\nFive lines\nSix lines";

	await composer.fill(`Remember ${"a short example ".repeat(120).trim()}`);
	await composer.press("Enter");
	await expect(latestReply).toBeAttached();
	await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
	await page.setViewportSize({ ...viewport, height: 352 });
	await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
	await composer.fill(multilineDraft);
	await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
	expect(await replyBottom()).toBeLessThan(await composerTop());

	await composer.fill("");
	await scroller.evaluate((element) => {
		element.scrollTop = 48;
	});
	await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(48);
	await composer.fill(multilineDraft);
	expect(await scroller.evaluate((element) => element.scrollTop)).toBe(48);
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
	expect(
		await page.locator(".chat-transcript").evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBe(0);
});

test("opens one tool row without scrolling its summary away", async ({ page }) => {
	await page.setViewportSize({ ...devices["iPhone 17 Pro"].viewport, height: 352 });
	const composer = await openChat(page);
	const transcript = page.getByRole("main");
	await composer.fill(`Remember ${"a short example ".repeat(120).trim()}`);
	await composer.press("Enter");
	await expect(transcript.getByText(/^Remembering a short example/)).toBeAttached();
	await composer.fill("Run a workspace module.");
	await composer.press("Enter");
	await expect(transcript.getByText(/Wrote .*42/)).toBeVisible();
	const card = transcript.locator(":scope > details");
	const summary = card.locator(":scope > summary");
	await expect(card).toHaveCount(1);
	await expect(summary).toHaveText("execDone");
	await expect(summary).toBeInViewport();
	const top = await summary.evaluate((element) => element.getBoundingClientRect().top);

	await summary.press("Enter");
	await expect(card.getByText("Arguments", { exact: true })).toBeVisible();
	await expect(card.getByText("Result", { exact: true })).toBeVisible();
	await expect(card.getByRole("list", { name: "Recent tool calls" })).toBeVisible();
	const blocks = card.locator("pre code");
	const themedToken = "span[style*='light-dark(']";
	await expect(blocks.nth(0).locator(themedToken).first()).toBeAttached();
	await expect(blocks.nth(1).locator(themedToken).first()).toBeAttached();
	await expect(blocks.nth(0)).toHaveText("42");
	expect(JSON.parse((await blocks.nth(1).textContent()) ?? "null")).toMatchObject({
		code: expect.stringContaining("return 42;"),
	});
	const expandedTop = await summary.evaluate(async (element) => {
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
		return element.getBoundingClientRect().top;
	});
	expect(Math.abs(expandedTop - top)).toBeLessThanOrEqual(1);
	await summary.press("Enter");
	await expect(card.getByText("Arguments", { exact: true })).toBeHidden();
});

test("fits Markdown frames to their tables and scrolls wide tables on mobile", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill(
		"Remember this table.\n\n| First column | Second column | Third column | Fourth column | Fifth column |\n| --- | --- | --- | --- | --- |\n| Alpha result | Beta result | Gamma result | Delta result | Epsilon result |",
	);
	await composer.press("Enter");
	const table = page.getByRole("table");
	await expect(table).toBeVisible();
	const scrolled = await table.evaluate((element) => {
		element.scrollLeft = element.scrollWidth;
		return element.scrollLeft;
	});
	expect(scrolled).toBeGreaterThan(0);
	expect(
		await page.locator(".chat-transcript").evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBe(0);

	await page.setViewportSize({ width: 1280, height: 720 });
	const rightGap = await table.evaluate((element) => {
		const lastHeading = element.querySelector("thead th:last-child");
		return lastHeading
			? element.getBoundingClientRect().right - lastHeading.getBoundingClientRect().right
			: Number.POSITIVE_INFINITY;
	});
	expect(rightGap).toBeGreaterThanOrEqual(0);
	expect(rightGap).toBeLessThanOrEqual(4);
});
