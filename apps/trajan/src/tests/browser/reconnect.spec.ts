import { setTimeout } from "node:timers/promises";
import { TurnSubmission } from "@trajan/harness";
import { devices } from "@playwright/test";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { Schema } from "effect";
import {
	ChatEvent,
	ChatHistoryPath,
	ChatLivePath,
	ChatPage,
	ChatPath,
	ChatReceipt,
} from "../../chat/protocol";
import { expect, test } from "./fixtures";

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ChatEvent));
const decodeSubmission = Schema.decodeUnknownSync(Schema.fromJsonString(TurnSubmission));
const decodeReceipt = Schema.decodeUnknownSync(ChatReceipt);
const decodeHistory = Schema.decodeUnknownSync(ChatPage);
const control = "/__browser-smoke/chat";

async function openChat(page: Page) {
	await page.goto("/");
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	return page.getByRole("textbox", { name: "Message Trajan" });
}

function toolCards(page: Page) {
	return page.getByRole("main").locator(".chat-tool-card");
}

function toolActivity(page: Page) {
	return page.getByRole("main").locator("[data-tool-activity]");
}

async function openToolCard(card: Locator) {
	const activity = card.locator("xpath=ancestor::details[1]");
	if ((await activity.getAttribute("open")) === null) {
		await activity.locator(":scope > summary").click();
	}
	await card.locator(":scope > summary").click();
}

function observeSubmissions(page: Page) {
	const prompts: Array<string> = [];
	page.on("request", (request) => {
		if (request.method() === "POST" && new URL(request.url()).pathname === ChatPath) {
			prompts.push(decodeSubmission(request.postData()).prompt);
		}
	});
	return prompts;
}

async function makeRetryDue(request: APIRequestContext, retry: "inbox-wake" | "missed-schedule") {
	await expect
		.poll(async () => (await request.post(`${control}/retry-${retry}`)).status(), {
			timeout: 10_000,
		})
		.toBe(204);
}

async function expectStoredReply(request: APIRequestContext, text: string) {
	await expect
		.poll(
			async () => {
				const response = await request.get(ChatHistoryPath);
				if (!response.ok()) {
					return 0;
				}
				return decodeHistory(await response.json()).entries.filter(
					({ message }) => message.role === "assistant" && message.text === text,
				).length;
			},
			{ timeout: 10_000 },
		)
		.toBe(1);
}

test("loads a skill saved in chat after the Worker restarts", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Save the weekly brief skill.");
	await composer.press("Enter");
	const completed = toolCards(page).filter({ hasText: "Done" });
	const replies = page
		.getByRole("main")
		.getByRole("paragraph")
		.filter({ hasText: "Weekly template v1" });
	await expect(completed).toHaveCount(1);
	await expect(replies).toHaveCount(1);
	await expect(replies.first()).toBeVisible();

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	await composer.fill("Use the weekly brief skill.");
	await composer.press("Enter");
	await expect(completed).toHaveCount(2);
	await expect(replies).toHaveCount(2);
	await expect(replies.last()).toBeVisible();

	const card = completed.first();
	await openToolCard(card);
	for (const { name, path, source, token } of [
		{
			name: "readSkillResource",
			path: "references/template.md",
			source: "# Weekly template v1\n\n- **Highlight**\n- Next up",
			token: "Weekly template v1",
		},
		{
			name: "read",
			path: "/workspace/weekly-brief.ts",
			source: "export function brief(topic: string) {\n  return { title: topic, ready: true };\n}",
			token: "export",
		},
	]) {
		const row = card.getByRole("listitem").filter({
			has: page.getByText(name, { exact: true }),
		});
		await row.locator("summary").click();
		await expect(row.getByText(path, { exact: true })).toBeVisible();
		const code = row.locator("pre code").last();
		await expect(code).toHaveText(source, { useInnerText: true });
		expect(await code.textContent()).toBe(source);
		await expect(code.locator("span[style]").filter({ hasText: token }).first()).toBeVisible();
	}
	expect(
		await page.locator(".chat-transcript").evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBeLessThanOrEqual(1);
});

test("uses the submission prompt limit for the composer", async ({ page }) => {
	const composer = await openChat(page);
	const send = page.getByRole("button", { name: "Send message" });
	await composer.fill("   ");
	await expect(send).toBeDisabled();
	await composer.fill(` ${"x".repeat(32_000)} `);
	await expect(send).toBeEnabled();
	await composer.fill("x".repeat(32_001));
	await expect(send).toBeDisabled();
});

test("waits for the chat snapshot on first connect and after a socket drop", async ({ page }) => {
	const submissions = observeSubmissions(page);
	let nextSnapshot = Promise.withResolvers<() => void>();
	let disconnect: (() => Promise<void>) | undefined;
	let holdSnapshot = true;
	await page.routeWebSocket(
		(url) => url.pathname === ChatLivePath,
		(client) => {
			const server = client.connectToServer();
			disconnect ??= () => client.close({ code: 1012, reason: "Restart" });
			server.onMessage((data) => {
				const frame = decodeFrame(String(data));
				if (frame._tag === "Some" && frame.value.type === "snapshot" && holdSnapshot) {
					holdSnapshot = false;
					nextSnapshot.resolve(() => client.send(data));
				} else {
					client.send(data);
				}
			});
		},
	);
	await page.goto("/");
	const composer = page.getByRole("textbox", { name: "Message Trajan" });
	const deliver = await nextSnapshot.promise;
	await composer.fill("Remember the blocked draft");
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	await composer.press("Enter");
	await expect(composer).toHaveValue(/^Remember the blocked draft\n?$/);
	expect(submissions).toEqual([]);
	deliver();
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	expect(submissions).toEqual([]);
	await composer.fill("Remember milk");
	holdSnapshot = true;
	nextSnapshot = Promise.withResolvers<() => void>();
	await disconnect?.();
	await expect(page.locator("header").getByRole("status")).toHaveText("Reconnecting");
	const deliverAfterReconnect = await nextSnapshot.promise;
	await expect(composer).toHaveValue("Remember milk");
	await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
	deliverAfterReconnect();
	await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
	await composer.press("Enter");
	await expect(page.getByRole("main").getByText("Remembering milk", { exact: true })).toHaveCount(
		1,
	);
	expect(submissions).toEqual(["Remember milk"]);
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

for (const admitted of [true, false]) {
	test(`recovers a send on reload ${admitted ? "after" : "before"} server admission`, async ({
		page,
	}) => {
		if (!admitted) {
			await page.setViewportSize({ width: 1440, height: 900 });
		}
		const requests: Array<typeof TurnSubmission.Type> = [];
		let initialPaused = false;
		let deliver: (() => Promise<void>) | undefined;
		await page.route("**/api/chat", async (route) => {
			requests.push(decodeSubmission(route.request().postData()));
			if (requests.length === 1) {
				if (admitted) {
					const response = await route.fetch();
					expect(decodeReceipt(await response.json()).accepted).toBe(true);
				}
				initialPaused = true;
				return;
			}
			const response = await route.fetch();
			expect(decodeReceipt(await response.json()).accepted).toBe(!admitted);
			deliver = () => route.fulfill({ response });
		});
		const composer = await openChat(page);
		await composer.fill("Remember the recovered send");
		await composer.press("Enter");
		await expect.poll(() => initialPaused).toBe(true);
		await page.reload();
		if (admitted) {
			await expect(composer).toHaveValue("");
		} else {
			await expect.poll(() => deliver !== undefined).toBe(true);
			await expect(composer).toHaveValue("Remember the recovered send");
		}
		await composer.fill("newer draft");
		await deliver?.();
		await expect(page.locator("form")).toHaveAttribute("aria-busy", "false");
		await expect(composer).toHaveValue("newer draft");
		const transcript = page.getByRole("main");
		await expect(
			transcript.getByText("Remembering the recovered send", { exact: true }),
		).toHaveCount(1);
		await page.reload();
		await expect(page.locator("header").getByRole("status")).toHaveText("Live");
		await expect(composer).toHaveValue("");
		await expect(transcript.getByText("Remember the recovered send", { exact: true })).toHaveCount(
			1,
		);
		expect(requests).toEqual(admitted ? [requests[0]] : [requests[0], requests[0]]);
	});
}

test("keeps the draft when a correlated HTTP 400 receipt rejects the submission", async ({
	page,
}) => {
	let requests = 0;
	await page.route("**/api/chat", async (route) => {
		const submission = decodeSubmission(route.request().postData());
		requests++;
		await route.fulfill({
			status: 400,
			json: {
				submissionId: submission.id,
				runId: null,
				accepted: false,
				error: "That submission ID already belongs to a different prompt.",
			},
		});
	});
	const composer = await openChat(page);
	await composer.fill("Remember milk");
	await composer.press("Enter");
	await expect(page.getByRole("alert")).toHaveText(
		"That submission ID already belongs to a different prompt.",
	);
	await expect(composer).toHaveValue("Remember milk");
	expect(requests).toBe(1);
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

test("restores a live draft and keeps its interrupted attempt without repeating the tool", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await composer.fill("hello");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	const live = transcript.locator('[data-streaming="true"]');
	const interrupted = transcript.locator("[data-interrupted-reply]");
	await expect(live).toHaveText("Wrote");
	await openChat(page);
	await expect(live).toHaveText("Wrote");
	await expect(interrupted).toHaveCount(0);
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await openChat(page);
	await expect(interrupted.locator("summary")).toHaveText("Interrupted reply");
	await expect(live).toHaveText("Wrote");
	await interrupted.locator("summary").click();
	await expect(interrupted.getByText("Wrote", { exact: true })).toBeVisible();
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(live).toHaveCount(0);
	await expect(interrupted.getByText("Wrote", { exact: true })).toBeVisible();
	await expect(transcript.getByText('Wrote "hello"', { exact: true })).toBeVisible();
	await expect(transcript.getByText("hello", { exact: true })).toHaveCount(1);
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	await expect(interrupted.locator("summary")).toHaveText("Interrupted reply");
	await expect(transcript.getByText('Wrote "hello"', { exact: true })).toHaveCount(1);
});

test("restores persisted model chunks before a restarted turn resumes", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await composer.fill("Stream a draft recovery example.");
	await composer.press("Enter");
	const live = page.getByRole("main").locator('[data-streaming="true"]');
	await expect(live).toContainText("I saved the checklist.");
	expect((await page.request.post(`${control}/pause-before-turn`)).status()).toBe(204);
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);

	await openChat(page);
	await expect(live).toContainText("The workspace is ready.");
	await expect(live).toContainText("I saved the checklist.");
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	await expect(live).toContainText("The workspace is ready.");
	await expect(live).toContainText("I saved the checklist.");

	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(
		page.getByRole("main").getByText("The final check passed.", { exact: true }),
	).toBeVisible();
	await expect(live).toHaveCount(0);
	const interrupted = page.getByRole("main").locator("[data-interrupted-reply]");
	await expect(interrupted).toHaveCount(1);
	await interrupted.locator("summary").click();
	await expect(interrupted).toContainText("I saved the checklist.");
});

test("shows animated progress with either motion preference", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const composer = await openChat(page);
	await composer.fill("Interrupt after writing.");
	await composer.press("Enter");
	const spinner = page.getByText("Running exec", { exact: true }).locator('[data-icon="loader"]');
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

test("runs a committed tool decision once after a Worker restart", async ({ page }) => {
	const composer = await openChat(page);
	const prompt = "Append through the tool handoff.";
	expect((await page.request.post(`${control}/pause-tool-handoff`)).status()).toBe(204);
	await composer.fill(prompt);
	await composer.press("Enter");
	const decodeState = Schema.decodeUnknownSync(
		Schema.Struct({
			text: Schema.String,
			pausedAt: Schema.optionalKey(Schema.String),
		}),
	);
	await expect
		.poll(async () => {
			const response = await page.request.post(`${control}/state`);
			return decodeState(await response.json());
		})
		.toMatchObject({ pausedAt: "after-tool-handoff", text: "" });
	await expect(toolCards(page)).toHaveCount(0);
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	const reply = `Wrote ${JSON.stringify(prompt)}`;
	await expect(page.getByRole("main").getByText(reply, { exact: true })).toBeVisible();
	await expect(toolCards(page)).toHaveCount(1);
	await expectStoredReply(page.request, reply);
});

test("recovers a running exec without repeating its write", async ({ page }) => {
	const composer = await openChat(page);
	const card = toolCards(page).last();
	const writes = card.getByRole("listitem").filter({ hasText: /write.*Succeeded/ });
	const decodeState = Schema.decodeUnknownSync(
		Schema.Struct({ text: Schema.String, pausedAt: Schema.optionalKey(Schema.String) }),
	);
	const readState = async () =>
		decodeState(await (await page.request.post(`${control}/state`)).json());
	await composer.fill("Interrupt after writing.");
	await composer.press("Enter");
	await expect(page.getByText("Running exec", { exact: true })).toBeVisible();
	await openToolCard(card);
	await expect(writes).toHaveCount(1);
	await page.reload();
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	await openToolCard(card);
	await expect(writes).toHaveCount(1);
	await expect.poll(readState).toMatchObject({ text: "once", pausedAt: "waiting-for-restart" });

	expect((await page.request.post(`${control}/pause-before-turn`)).status()).toBe(204);
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	const transcript = page.getByRole("main");
	const reply = transcript.getByText('Wrote "once"', { exact: true });
	await openChat(page);
	await expect.poll(readState).toMatchObject({ text: "once", pausedAt: "before-turn" });
	await expect(toolCards(page)).toHaveCount(1);
	await openToolCard(card);
	await expect(writes).toBeVisible();
	await expect(card.getByRole("listitem").filter({ hasText: "wait_for_restart" })).toHaveCount(0);
	await expect(reply).toHaveCount(0);

	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	await expect(toolCards(page)).toHaveCount(1);
	await openToolCard(card);
	await expect(writes).toBeVisible();
	await expect(reply).toHaveCount(0);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(reply).toHaveCount(1);
	await page.reload();
	await expect(reply).toHaveCount(1);
	await expect(toolCards(page)).toHaveCount(1);
	await openToolCard(card);
	await expect(writes).toHaveCount(1);
	await composer.fill("hello");
	await composer.press("Enter");
	await expect(transcript.getByText('Wrote "oncehello"', { exact: true })).toBeVisible();
});

for (const scenario of [
	{ prompt: "Interrupt after writing.", notice: "Stopped", diff: "once", stop: true },
	{
		prompt: "Fail the model after writing.",
		notice: "The fixture model failed after writing.",
		diff: "Fail the model after writing.",
		stop: false,
	},
]) {
	test(`keeps the committed file diff after ${scenario.stop ? "stopping on iPhone" : "model failure on desktop"}`, async ({
		page,
	}) => {
		if (!scenario.stop) {
			await page.setViewportSize({ width: 1440, height: 900 });
		}
		const composer = await openChat(page);
		await composer.fill(scenario.prompt);
		await composer.press("Enter");
		const card = toolCards(page).last();
		const write = card
			.getByRole("listitem")
			.filter({ has: page.getByText("write", { exact: true }) });
		if (scenario.stop) {
			await openToolCard(card);
			await expect(write).toHaveText(/write.*Succeeded/);
			await page.getByRole("button", { name: "Stop" }).click();
		}
		await expect(page.getByRole("main").getByText(scenario.notice, { exact: true })).toBeVisible();
		await page.reload();
		await expect(page.getByRole("main").getByText(scenario.notice, { exact: true })).toBeVisible();
		await openToolCard(card);
		await expect(write).toHaveText(/write.*Succeeded/);
		await write.locator(":scope > details > summary").click();
		await expect(write.getByRole("region", { name: "File changes" }).locator("pre")).toContainText(
			scenario.diff,
		);
	});
}

test("keeps the same tool card open through recovery, streaming, and commit", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay`)).status()).toBe(204);
	await composer.fill("Replay two reads.");
	await composer.press("Enter");
	const card = toolCards(page).last();
	const summary = card.locator(":scope > summary");
	const calls = card.getByRole("list", { name: "Tool calls" }).getByRole("listitem");
	await openToolCard(card);
	await expect(calls).toHaveText([/read_first.*Succeeded/, /read_second.*Running/]);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	await openToolCard(card);
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

test("streams successive tools into the open activity disclosure above the reply", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-between-tools`)).status()).toBe(204);
	await composer.fill("Append hello, then world.");
	await composer.press("Enter");
	const cards = toolCards(page);
	const first = cards.first();
	const activity = toolActivity(page);
	await expect(first.locator(":scope > summary")).toHaveText("execDone");
	await expect(page.getByText("Waiting for the model", { exact: true })).toBeVisible();
	await expect(cards).toHaveCount(1);
	await expect(activity).toHaveText("Working…");
	await expect(activity.locator('[data-icon="loader"]')).toBeVisible();
	await expect(first).toBeHidden();
	await openToolCard(first);
	await expect(first.locator("pre").first()).toHaveText('"hello"');

	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await expect(page.getByText("Responding", { exact: true })).toBeVisible();
	await expect(cards).toHaveCount(2);
	await expect(activity).toHaveText("Working…");
	await expect(cards.last()).toBeVisible();
	await expect(first).toHaveAttribute("open");
	await expect(cards.last().locator(":scope > summary")).toHaveText("execDone");
	await openToolCard(cards.last());
	await expect(cards.last().locator("pre").first()).toHaveText('"hello world"');

	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(
		page.getByRole("main").getByText('Wrote "hello world"', { exact: true }),
	).toBeVisible();
	await expect(cards).toHaveCount(2);
	await expect(first).toHaveAttribute("open");
	await expect(cards.last()).toHaveAttribute("open");
	await expect(activity).toHaveText("Tool activity");
	await expect(activity.locator('[data-icon="loader"]')).toHaveCount(0);
});

test("restores a completed exec while its turn is still active", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-between-tools`)).status()).toBe(204);
	await composer.fill("Append hello, then world.");
	await composer.press("Enter");
	const cards = toolCards(page);
	const first = cards.first();
	await expect(first.locator(":scope > summary")).toHaveText("execDone");
	await expect(page.getByText("Waiting for the model", { exact: true })).toBeVisible();

	expect((await page.request.post(`${control}/pause-before-turn`)).status()).toBe(204);
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await openChat(page);
	await expect(cards).toHaveCount(1);
	await expect(first.locator(":scope > summary")).toHaveText("execDone");
	await openToolCard(first);
	await expect(first.locator("pre").first()).toHaveText('"hello"');
	await expect(first.getByRole("listitem").filter({ hasText: /write.*Succeeded/ })).toBeVisible();

	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(
		page.getByRole("main").getByText('Wrote "hello world"', { exact: true }),
	).toBeVisible();
	await expect(cards).toHaveCount(2);
	await expect(first).toHaveAttribute("open");
});

test("keeps the partial exec and its write visible after five Worker restarts", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay`)).status()).toBe(204);
	await composer.fill("Recover an exec after repeated restarts.");
	await composer.press("Enter");
	const decodePause = Schema.decodeUnknownSync(
		Schema.Struct({ instance: Schema.String, pausedInstance: Schema.optionalKey(Schema.String) }),
	);
	let previous: string | undefined;
	for (let count = 0; count < 5; count++) {
		await expect
			.poll(
				async () => {
					const response = await page.request.post(`${control}/state`);
					if (!response.ok()) {
						return false;
					}
					const { instance, pausedInstance } = decodePause(await response.json());
					if (instance === previous || instance !== pausedInstance) {
						return false;
					}
					previous = instance;
					return true;
				},
				{ timeout: 7000 },
			)
			.toBe(true);
		expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
		await openChat(page);
	}
	const card = toolCards(page).first();
	await expect(toolActivity(page)).toHaveText(/Outcome unknown/);
	await expect(card.locator(":scope > summary")).toHaveText("execOutcome unknown");
	await openToolCard(card);
	const write = card.getByRole("listitem").filter({ hasText: /write.*Succeeded/ });
	await write.locator("summary").click();
	await expect(write.getByRole("region", { name: "File changes" })).toContainText("written");
	await expect(
		page
			.getByRole("main")
			.getByText(/script was interrupted 5 times/)
			.first(),
	).toBeVisible();
});

test("shows an exhausted model retry budget and keeps the completed write after reconnecting", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-between-tools`)).status()).toBe(204);
	await composer.fill("Append hello, then world.");
	await composer.press("Enter");
	await expect(toolActivity(page)).toHaveText("Working…");
	await composer.fill("Remember that queued work recovered");
	await composer.press("Enter");
	await expect(page.getByText("1 queued behind this run", { exact: true })).toBeVisible();

	const decodePause = Schema.decodeUnknownSync(
		Schema.Struct({ instance: Schema.String, pausedInstance: Schema.optionalKey(Schema.String) }),
	);
	for (let count = 0; count < 4; count++) {
		await expect
			.poll(
				async () => {
					const response = await page.request.post(`${control}/state`);
					if (!response.ok()) {
						return false;
					}
					const { instance, pausedInstance } = decodePause(await response.json());
					return instance === pausedInstance;
				},
				{ timeout: 7000 },
			)
			.toBe(true);
		expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
		await openChat(page);
	}

	const transcript = page.getByRole("main");
	const message = "The model request was interrupted and its retry budget is exhausted.";
	const notice = transcript.getByRole("alert").filter({ hasText: message });
	await expect(notice).toHaveCount(1);
	await expect(notice).toBeVisible();
	await expect(
		transcript.getByText("Remembering that queued work recovered", { exact: true }),
	).toBeVisible();
	await expect(toolActivity(page)).toHaveText("Tool activity");
	const card = toolCards(page).first();
	await openToolCard(card);
	const write = card.getByRole("listitem").filter({ hasText: /write.*Succeeded/ });
	await write.locator("summary").click();
	await expect(write.getByRole("region", { name: "File changes" }).locator("pre")).toContainText(
		"hello",
	);

	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	await expect(notice).toHaveCount(1);
	await expect(notice).toBeVisible();
	await expect(toolActivity(page)).toHaveText("Tool activity");
});

async function sendAndWaitForRetry(page: Page, composer: Locator, prompt: string) {
	await composer.fill(prompt);
	const submission = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" && new URL(response.url()).pathname === ChatPath,
	);
	await composer.press("Enter");
	const { runId } = decodeReceipt(await (await submission).json());
	expect(runId).not.toBeNull();
	await expect
		.poll(async () => {
			const response = await page.request.post(`${control}/task-state`, {
				params: { runId: runId ?? "" },
			});
			return response.ok() ? response.text() : undefined;
		})
		.toBe("waiting");
}

test("restores the partial and final replies after a restart during model backoff", async ({
	page,
}) => {
	const composer = await openChat(page);
	const prompt = "Retry an interrupted stream after append.";
	await sendAndWaitForRetry(page, composer, prompt);
	const transcript = page.getByRole("main");
	const interrupted = transcript.locator("[data-interrupted-reply]");
	await expect(interrupted.locator("summary")).toHaveText("Interrupted reply");
	await expect(transcript.locator('[data-streaming="true"]')).toHaveCount(0);
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await openChat(page);
	const reply = `Wrote "${prompt}"`;
	await expect(transcript.getByText(reply, { exact: true })).toBeVisible();
	await expect(toolCards(page)).toHaveCount(1);
	await interrupted.locator("summary").click();
	await expect(interrupted.getByText("Wrote", { exact: true })).toBeVisible();
	await expectStoredReply(page.request, reply);
});

test("shows a completed reply once after a transcript retry and reconnect", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/fail-transcript-write`)).status()).toBe(204);
	await sendAndWaitForRetry(page, composer, "hello");
	await composer.fill("Remember transcript retry recovered");
	await composer.press("Enter");
	await expect(page.getByText("1 queued behind this run", { exact: true })).toBeVisible();

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await openChat(page);
	expect((await page.request.post(`${control}/restore-transcript-write`)).status()).toBe(204);

	const transcript = page.getByRole("main");
	const reply = transcript.getByText('Wrote "hello"', { exact: true });
	await expect(reply).toBeVisible();
	await expect(
		transcript.getByText("Remembering transcript retry recovered", { exact: true }),
	).toBeVisible();
	await expect(reply).toHaveCount(1);
	await expect(toolCards(page)).toHaveCount(1);
	await expectStoredReply(page.request, 'Wrote "hello"');
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
	await openToolCard(toolCards(page).last());
	await expect(transcript.getByRole("list", { name: "Tool calls" })).toContainText("write");
});

test("replays time and randomness when reopening a file after a restart", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay`)).status()).toBe(204);
	await composer.fill("Recover a file named with time and randomness.");
	await composer.press("Enter");
	await openToolCard(toolCards(page).last());
	const calls = page.getByRole("list", { name: "Tool calls" }).getByRole("listitem");
	await expect(calls).toHaveText([
		/runtime\.now.*Succeeded/,
		/runtime\.randomUUID.*Succeeded/,
		/runtime\.random.*Succeeded/,
		/write.*Succeeded/,
		/read_second.*Running/,
	]);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await openToolCard(toolCards(page).last());
	await expect(calls.last()).toHaveText(/read_second.*Running/);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);

	const transcript = page.getByRole("main");
	await expect(transcript.getByText(/^Wrote "\/workspace\/\d+-[a-f0-9-]{36}\.txt"$/)).toHaveCount(
		1,
	);
	await expect(calls.last()).toHaveText(/^read.*Succeeded/);
});

test("replay shows the completed edit and diff after a reset before commit", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay-edit`)).status()).toBe(204);
	await composer.fill("Recover an interrupted edit.");
	await composer.press("Enter");
	const calls = page.getByRole("list", { name: "Tool calls" }).getByRole("listitem");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText(/Recovered .*"edit":"completed".*"text":"seed!"/)).toHaveCount(
		1,
	);
	await openToolCard(toolCards(page).last());
	const edit = calls.filter({ hasText: /edit.*Succeeded/ });
	await expect(edit).toHaveCount(1);
	await edit.locator("summary").press("Enter");
	await expect(edit.getByRole("region", { name: "File changes" }).locator("pre")).toContainText(
		"seed!",
	);
	await expect(calls.last()).toHaveText(/read.*Succeeded/);
});

test("restores the write and edit diffs after a restart and follows the chat theme", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const composer = await openChat(page);
	await composer.fill("Recover file diffs.");
	await composer.press("Enter");
	const card = toolCards(page).last();
	await openToolCard(card);
	const calls = card.getByRole("listitem");
	await expect(calls.last()).toHaveText(/wait_for_restart.*Running/);

	const openDiff = async (name: string) => {
		const row = calls.filter({ has: page.getByText(name, { exact: true }) });
		await row.locator(":scope > details > summary").click();
		return row.getByRole("region", { name: "File changes" }).locator("diffs-container");
	};
	const before = await openDiff("edit");
	await expect(before.locator("pre")).toContainText("ready: true");
	const original = await before.locator("pre").textContent();

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	await expect(page.getByText("Updated the report.", { exact: true })).toBeVisible();
	await openToolCard(card);
	const written = await openDiff("write");
	const edited = await openDiff("edit");
	await expect(written.locator("pre")).toContainText("ready: false");
	await expect(edited.locator("pre")).toContainText("ready: true");
	expect(await edited.locator("pre").textContent()).toBe(original);
	const writeRow = calls.filter({ has: page.getByText("write", { exact: true }) });
	await expect(writeRow.getByText("Result", { exact: true })).toBeHidden();
	await writeRow.getByText("Arguments and receipt", { exact: true }).click();
	await expect(writeRow.getByText(/"bytesWritten": 68/)).toBeVisible();
	await writeRow.getByText("Arguments and receipt", { exact: true }).click();

	const setTheme = async (name: string) => {
		await page.getByRole("button", { name: "Chat settings" }).click();
		await page.getByRole("menuitemradio", { name, exact: true }).click();
	};
	await setTheme("Light");
	await expect(written).toHaveCSS("color-scheme", "light");
	await expect(edited).toHaveCSS("color-scheme", "light");
	await setTheme("Dark");
	await expect(edited).toHaveCSS("color-scheme", "dark");
	await setTheme("Auto");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "auto");

	expect(
		await page.locator(".chat-transcript").evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBeLessThanOrEqual(1);
});

test("replay completes Git branch creation after a reset before commit", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay-git`)).status()).toBe(204);
	await composer.fill("Recover interrupted Git branch creation.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(transcript.getByText(/^Recovered .*"branchExists":true/)).toHaveCount(1);
	await openToolCard(toolCards(page).last());
	const calls = transcript.getByRole("list", { name: "Tool calls" }).getByRole("listitem");
	const branch = calls.filter({ has: page.getByText("git.branch", { exact: true }) });
	await expect(branch).toHaveText(/Succeeded/);
	await expect(calls.filter({ hasText: /git\.status.*Succeeded/ })).toBeVisible();
});

test("shows an unknown remote outcome after an exec catches the interruption", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-remote-push`)).status()).toBe(204);
	await composer.fill("Recover the interrupted remote push.");
	await composer.press("Enter");
	await expect
		.poll(async () => {
			const response = await page.request.post(`${control}/state`);
			return Schema.decodeUnknownSync(
				Schema.Struct({ pausedAt: Schema.optionalKey(Schema.String) }),
			)(await response.json()).pausedAt;
		})
		.toBe("during-remote-push");
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	const card = toolCards(page).last();
	await expect(toolActivity(page).last()).toContainText("Outcome unknown");
	await expect(card).toBeHidden();
	await openToolCard(card);
	await expect(
		card.getByText(/Remote outcome unknown.*refs\/heads\/review.*upstream/),
	).toBeVisible();
	await expect(
		page
			.getByRole("main")
			.getByText("Verify the remote branch before retrying the push.", { exact: true }),
	).toBeVisible();
});

test("shows a confirmed remote push after recovery", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-remote-push`)).status()).toBe(204);
	await composer.fill("Recover the confirmed remote push.");
	await composer.press("Enter");
	await expect
		.poll(async () => {
			const response = await page.request.post(`${control}/state`);
			return Schema.decodeUnknownSync(
				Schema.Struct({ pausedAt: Schema.optionalKey(Schema.String) }),
			)(await response.json()).pausedAt;
		})
		.toBe("during-remote-push");
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await openChat(page);
	await expect(
		page.getByRole("main").getByText("Verified the remote branch at the expected commit."),
	).toBeVisible();
	const card = toolCards(page).last();
	await openToolCard(card);
	await expect(
		card.getByRole("listitem").filter({ hasText: /git\.push.*Succeeded/ }),
	).toBeVisible();
	await expect(toolActivity(page).last()).not.toContainText("Outcome unknown");
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

test("an accepted send recovers after inbox wake retries fail with the chat closed", async ({
	page,
	context,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/fail-inbox-wake`)).status()).toBe(204);
	await composer.fill("Remember the inbox wake recovered");
	const admitted = page.waitForResponse(
		(response) => new URL(response.url()).pathname === ChatPath && response.status() === 202,
	);
	await composer.press("Enter");
	await admitted;
	await page.close();

	await makeRetryDue(context.request, "inbox-wake");
	await expectStoredReply(context.request, "Remembering the inbox wake recovered");
	const reopened = await context.newPage();
	await openChat(reopened);
	await expect(
		reopened.getByRole("main").getByText("Remembering the inbox wake recovered", { exact: true }),
	).toHaveCount(1);
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
	await expectStoredReply(context.request, "The scheduled workspace check ran.");
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

test("a missed scheduled turn leaves a single notice that survives reload", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/miss-schedule`)).status()).toBe(204);
	await composer.fill("Schedule a workspace check.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	const notice = transcript.getByText(/A scheduled task could not be queued after retries\./);
	await expect(notice).toHaveCount(1);
	await page.reload();
	await expect(notice).toHaveCount(1);
	await expect(
		transcript.getByText("The scheduled workspace check ran.", { exact: true }),
	).toHaveCount(0);
});

test("shows the missed schedule after the notice write recovers", async ({ page }) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/defer-missed-schedule`)).status()).toBe(204);
	await composer.fill("Schedule a workspace check.");
	await composer.press("Enter");
	const notice = page
		.getByRole("main")
		.getByText(/A scheduled task could not be queued after retries\./);
	await makeRetryDue(page.request, "missed-schedule");
	await expect(notice).toHaveCount(1);
	await page.reload();
	await expect(notice).toHaveCount(1);
});

test("replays the original schedule receipt after its one-time job has fired", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Schedule a workspace check and wait.");
	await composer.press("Enter");
	const card = toolCards(page).last();
	await openToolCard(card);
	const receipt = card.getByRole("listitem").filter({ hasText: /scheduleTurn.*Succeeded/ });
	await expect(receipt).toBeVisible();
	await expect(page.getByText("1 queued behind this run")).toBeVisible();
	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await page.reload();
	const transcript = page.getByRole("main");
	await expect(transcript.getByText(/^Scheduled \{/)).toHaveCount(1);
	await expect(
		transcript.getByText("The scheduled workspace check ran.", { exact: true }),
	).toHaveCount(1);
});

test("keeps completed workspace writes when a concurrent call is interrupted by a restart", async ({
	page,
}) => {
	const composer = await openChat(page);
	expect((await page.request.post(`${control}/pause-replay`)).status()).toBe(204);
	await composer.fill("Run parallel workspace recovery.");
	await composer.press("Enter");
	const card = toolCards(page).last();
	await openToolCard(card);
	const calls = card.getByRole("list", { name: "Tool calls" }).getByRole("listitem");
	await expect(calls.filter({ hasText: /read_second.*Running/ })).toHaveCount(1);
	await expect(calls.filter({ hasText: /write.*Succeeded/ })).toHaveCount(2);

	expect((await page.request.post(`${control}/crash`)).status()).toBe(500);
	await openChat(page);
	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	const reply = page.getByRole("main").getByText(/Wrote.*winner.*results/);
	await expect(reply).toBeVisible();
	await expect(reply).toHaveCount(1);
	await openToolCard(card);
	await expect(calls.filter({ hasText: /write.*Succeeded/ })).toHaveCount(2);
	await expect(calls.filter({ hasText: /read_second.*Succeeded/ })).toHaveCount(1);
	await page.setViewportSize({ width: 1440, height: 900 });
	await openChat(page);
	await expect(reply).toHaveCount(1);
	await openToolCard(card);
	await expect(calls).toHaveCount(3);
});

test("keeps separate outcomes for concurrent calls to the same tool", async ({ page }) => {
	const composer = await openChat(page);
	await composer.fill("Run a workspace module.");
	await composer.press("Enter");
	const transcript = page.getByRole("main");
	await expect(toolCards(page).last().locator(":scope > summary")).toHaveText("execDone");
	await expect(transcript.getByText(/Wrote .*42/)).toBeVisible();
	await page.reload();
	await openToolCard(toolCards(page).last());
	const calls = transcript.getByRole("list", { name: "Tool calls" }).getByRole("listitem");
	await expect(calls).toHaveCount(3);
	await expect(calls.filter({ hasText: /write.*Succeeded/ })).toBeVisible();
	const found = calls.filter({ hasText: /read.*Succeeded/ });
	const missing = calls.filter({ hasText: /read.*Failed/ });
	await expect(found.locator("pre")).toHaveCount(0);
	await expect(missing.locator("pre")).toHaveCount(0);
	await found.locator("summary").click();
	await expect(found.locator("pre").nth(0)).toContainText("/workspace/module.txt");
	await expect(found.locator("pre").nth(1)).toHaveText("hello");
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
	const card = toolCards(page);
	await expect(card.locator(":scope > summary")).toHaveText("execOutcome unknown");
	await expect(toolActivity(page)).toContainText("Outcome unknown");
	await expect(card).toBeHidden();
	await expect(
		transcript.getByText(/Inspect it before repeating the action/).filter({ visible: true }),
	).toBeVisible();
	await openToolCard(card);
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
	await expect(dark).toHaveCSS("border-top-left-radius", "22px");
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
	const composerSurface = composer.locator("..");
	const composerHeight = () =>
		composer.evaluate((element) => element.parentElement?.getBoundingClientRect().height);
	const controlHeight = await settings.evaluate(
		(element) => element.getBoundingClientRect().height,
	);
	await expect.poll(composerHeight).toBe(controlHeight);
	await expect(composerSurface).toHaveCSS("border-top-left-radius", "26px");
	await composer.fill("Remember the first line");
	await composer.press("Shift+Enter");
	await composer.pressSequentially("and the second");
	await expect(composer).toHaveValue("Remember the first line\nand the second");
	await expect.poll(composerHeight).toBeGreaterThan(controlHeight);
	await expect(composerSurface).toHaveCSS("border-top-left-radius", "26px");
	await expect(send).toBeInViewport();

	await composer.press("Enter");
	await expect(page.getByRole("main")).toContainText("Remembering the first line");
	await expect.poll(composerHeight).toBe(controlHeight);
});

test("keeps IME confirmation separate from sending a message", async ({ page }) => {
	const submissions = observeSubmissions(page);
	const composer = await openChat(page);
	const send = page.getByRole("button", { name: "Send message" });
	const transcript = page.getByRole("main");
	const draft = "Remember 日本語";
	const composingDraft = "Remember にほんご";
	await composer.dispatchEvent("compositionstart");
	await composer.fill(composingDraft);
	await expect(send).toBeEnabled();
	await composer.dispatchEvent("keydown", { key: "Enter", isComposing: true });
	await expect(composer).toHaveValue(composingDraft);
	expect(submissions).toEqual([]);
	await composer.fill(draft);
	await composer.dispatchEvent("compositionend", { data: "日本語" });
	await composer.press("Enter");
	await expect(transcript.getByText("Remembering 日本語", { exact: true })).toHaveCount(1);
	await expect(composer).toHaveValue("");
	expect(submissions).toEqual([draft]);
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

test("renders Mermaid during streaming and restores it from chat history", async ({ page }) => {
	const composer = await openChat(page);
	const graphics = page.locator('[data-markdown="mermaid"] > svg');
	const flow = graphics.filter({ hasText: "Delivery flow" });
	const edgeStroke = flow.locator(".pele-edges");

	expect((await page.request.post(`${control}/pause`)).status()).toBe(204);
	await composer.fill("Show the delivery flow.");
	await composer.press("Enter");
	await expect(flow.getByText("Running", { exact: true })).toBeVisible();
	await expect(page.locator('[data-streaming="true"]').locator("svg.pele")).toHaveCount(1);
	await expect(flow.getByText("Delivered", { exact: true })).toHaveCount(0);

	expect((await page.request.post(`${control}/release`)).status()).toBe(204);
	await expect(flow.getByText("Delivered", { exact: true })).toBeVisible();
	await expect(graphics.nth(1).getByText("Confirm delivery", { exact: true })).toBeVisible();
	await expect(flow.locator("a")).toHaveCount(0);
	await expect(page.locator('[data-streaming="true"]')).toHaveCount(0);
	expect(
		await page.locator(".chat-transcript").evaluate((node) => node.scrollWidth - node.clientWidth),
	).toBe(0);

	await page.getByRole("button", { name: "Chat settings" }).click();
	await page.getByRole("menuitemradio", { name: "Light", exact: true }).click();
	const light = await edgeStroke.evaluate((edge) => getComputedStyle(edge).stroke);
	await page.getByRole("button", { name: "Chat settings" }).click();
	await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
	await expect(edgeStroke).not.toHaveCSS("stroke", light);

	await page.reload();
	await expect(flow.getByText("Delivered", { exact: true })).toBeVisible();
	await expect(graphics).toHaveCount(2);
	await composer.fill("Show invalid Mermaid.");
	await composer.press("Enter");
	await expect(
		page.locator('[data-markdown="code-block"] code').filter({ hasText: "not a Mermaid diagram" }),
	).toBeVisible();
	await expect(graphics).toHaveCount(2);
});

test("follows the Pierre palette for Mermaid chart series in Auto", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "light" });
	const composer = await openChat(page);
	await composer.fill("Show the delivery breakdown.");
	await composer.press("Enter");
	const slices = page.locator(".pele-slice");
	await expect(slices).toHaveCount(2);
	const delivered = slices.first();
	const queued = slices.last();
	const lightDelivered = await delivered.evaluate((element) => getComputedStyle(element).fill);
	const lightQueued = await queued.evaluate((element) => getComputedStyle(element).fill);
	expect(lightDelivered).not.toBe(lightQueued);
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(delivered).not.toHaveCSS("fill", lightDelivered);
	await expect(queued).not.toHaveCSS("fill", lightQueued);
	await expect(queued).not.toHaveCSS(
		"fill",
		await delivered.evaluate((element) => getComputedStyle(element).fill),
	);
});

const formatterPath = "/src/format-exec-script.ts";
const workspaceModuleSource = `import { read, write } from "codemode:tools";
export default async function () {
  const path = "/workspace/module.txt";
  const written = await write({ path, content: "hello" });
  const [found, missing] = await Promise.all([read({ path }), read({ path: "/workspace/missing.txt" })]);
  if (written.isError || found.isError || !missing.isError) throw new Error("Unexpected tool result");
  return 42;
}`;

test("keeps the collapsed tool card compact and opens it without scrolling its summary away", async ({
	page,
}) => {
	let formatterRequested = false;
	page.on("request", (request) => {
		if (new URL(request.url()).pathname === formatterPath) {
			formatterRequested = true;
		}
	});
	await page.setViewportSize({ ...devices["iPhone 17 Pro"].viewport, height: 352 });
	const composer = await openChat(page);
	const transcript = page.getByRole("main");
	await composer.fill(`Remember ${"a short example ".repeat(120).trim()}`);
	await composer.press("Enter");
	await expect(transcript.getByText(/^Remembering a short example/)).toBeAttached();
	await composer.fill("Run a workspace module.");
	await composer.press("Enter");
	await expect(transcript.getByText(/Wrote .*42/)).toBeVisible();
	const card = toolCards(page);
	const summary = card.locator(":scope > summary");
	const activity = toolActivity(page);
	await expect(card).toHaveCount(1);
	await expect(activity).toHaveText("Tool activity");
	await expect(activity).toBeInViewport();
	await expect(card).toBeHidden();
	const row = await activity.boundingBox();
	expect(row?.height).toBeLessThanOrEqual(32);
	await expect(activity).toHaveCSS("border-top-width", "0px");
	expect(
		await transcript.getByText(/Wrote .*42/).evaluate((reply) => reply.getBoundingClientRect().top),
	).toBeGreaterThanOrEqual((row?.y ?? 0) + (row?.height ?? 0));
	const rowTop = await activity.evaluate((element) => element.getBoundingClientRect().top);
	await activity.press("Enter");
	await expect(card).toBeVisible();
	const openedRowTop = await activity.evaluate((element) => element.getBoundingClientRect().top);
	expect(Math.abs(openedRowTop - rowTop)).toBeLessThanOrEqual(1);
	await summary.scrollIntoViewIfNeeded();
	await expect(summary).toHaveText("execDone");
	await expect(summary).toBeInViewport();
	const width = () => card.evaluate((element) => element.getBoundingClientRect().width);
	const contentWidth = await transcript.evaluate((element) => {
		const style = getComputedStyle(element);
		return (
			element.clientWidth -
			Number.parseFloat(style.paddingLeft) -
			Number.parseFloat(style.paddingRight)
		);
	});
	const collapsedWidth = await width();
	expect(collapsedWidth).toBeLessThan(contentWidth);
	const collapsedCorners = await card.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			top: Number.parseFloat(style.borderTopLeftRadius),
			bottom: Number.parseFloat(style.borderBottomLeftRadius),
			height: element.getBoundingClientRect().height,
		};
	});
	expect(collapsedCorners.top + collapsedCorners.bottom).toBeLessThanOrEqual(
		collapsedCorners.height,
	);
	const top = await summary.evaluate((element) => element.getBoundingClientRect().top);
	expect(formatterRequested).toBe(false);

	await summary.press("Enter");
	const scriptHeading = card.getByText("Script", { exact: true });
	await expect(scriptHeading).toBeVisible();
	await expect.poll(width).toBeCloseTo(contentWidth, 0);
	await expect(card).toHaveCSS("border-top-left-radius", `${collapsedCorners.top}px`);
	await expect(card.getByText("Result", { exact: true })).toBeVisible();
	await expect(card.getByRole("list", { name: "Tool calls" })).toBeVisible();
	const blocks = card.locator("pre code");
	const themedToken = "span[style*='light-dark(']";
	await expect(blocks.nth(0).locator(themedToken).first()).toBeAttached();
	await expect(blocks.nth(0)).toHaveText("42");
	const script = blocks.nth(1);
	await expect(script.locator(themedToken).filter({ hasText: "import" })).toBeAttached();
	const original = card.getByRole("button", { name: "Original", exact: true });
	await expect(original).toHaveAttribute("aria-pressed", "false");
	expect(formatterRequested).toBe(true);
	const formatted = await script.textContent();
	expect(formatted).toContain("await Promise.all([\n    read({ path }),");
	const expandedTop = await summary.evaluate(async (element) => {
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
		return element.getBoundingClientRect().top;
	});
	expect(Math.abs(expandedTop - top)).toBeLessThanOrEqual(1);
	await original.click();
	await expect(original).toHaveAttribute("aria-pressed", "true");
	expect(await script.textContent()).toBe(workspaceModuleSource);
	await original.click();
	await expect(original).toHaveAttribute("aria-pressed", "false");
	expect(await script.textContent()).toBe(formatted);
	await summary.press("Enter");
	await expect(scriptHeading).toBeHidden();
	await expect.poll(width).toBeCloseTo(collapsedWidth, 0);
});

test("shows the original exec script if the formatter cannot load", async ({ page }) => {
	await page.route(
		(url) => url.pathname === formatterPath,
		(route) => route.abort(),
	);
	const composer = await openChat(page);
	await composer.fill("Run a workspace module.");
	await composer.press("Enter");
	const card = toolCards(page).first();
	await expect(card.locator(":scope > summary")).toHaveText("execDone");
	const formatterFailure = page.waitForEvent(
		"requestfailed",
		(request) => new URL(request.url()).pathname === formatterPath,
	);
	await openToolCard(card);
	await formatterFailure;
	const script = card.locator("pre code").last();
	await expect(script.locator("span[style]").filter({ hasText: "import" })).toBeVisible();
	expect(await script.textContent()).toBe(workspaceModuleSource);
	await expect(card.getByRole("button", { name: "Original", exact: true })).toHaveCount(0);
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
