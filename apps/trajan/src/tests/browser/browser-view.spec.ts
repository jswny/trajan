import type { Locator, Page } from "@playwright/test";
import { Schema } from "effect";
import { BrowserViewPath, BrowserViewRequest, ChatLivePath } from "../../chat/protocol";
import type { ChatEvent, ChatSnapshot } from "../../chat/protocol";
import { expect, test } from "./fixtures";

const decodeViewRequest = Schema.decodeUnknownSync(BrowserViewRequest);
const viewLeaseMs = 60_000;
const hostedView = "https://live.browser.run/ui/view?mode=tab&wss=fixture";
const chipGeometry = (chip: Locator) =>
	chip.evaluate((element) => ({
		height: element.getBoundingClientRect().height,
		radius: Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
	}));
const browsingTurn = {
	runId: "browser-run",
	submissionId: "browser-prompt",
	prompt: "Open a page",
	state: "running",
} as const;
const history = Array.from({ length: 24 }, (_, index) => ({
	id: index + 1,
	submissionId: `earlier-${index + 1}`,
	message: { role: "assistant" as const, text: `Earlier reply ${index + 1}` },
}));

async function mockLiveBrowser(page: Page) {
	const snapshot = {
		type: "snapshot",
		page: { entries: history, nextBefore: null },
		queued: 0,
		active: null,
		preview: null,
		browserWatch: null,
	} satisfies typeof ChatSnapshot.Type;
	const connected = Promise.withResolvers<(event: typeof ChatEvent.Type) => void>();
	const viewRequests: Array<string> = [];
	let frameRequests = 0;
	const now = () => page.evaluate(() => Date.now());
	const watch = async (id: string) => ({ id, expiresAt: (await now()) + 120_000 });

	await page.routeWebSocket(
		(url) => url.pathname === ChatLivePath,
		(client) => {
			const send = (event: typeof ChatEvent.Type) => client.send(JSON.stringify(event));
			send(snapshot);
			connected.resolve(send);
		},
	);
	await page.route(`**${BrowserViewPath}`, async (route) => {
		expect(route.request().method()).toBe("POST");
		const { id } = decodeViewRequest(route.request().postDataJSON());
		viewRequests.push(id);
		return route.fulfill({
			json: { status: "open", url: hostedView, expiresAt: (await now()) + viewLeaseMs },
		});
	});
	await page.route(hostedView, (route) => {
		frameRequests += 1;
		return route.fulfill({ contentType: "text/html", body: "<h1>Browser page</h1>" });
	});
	await page.goto("/");
	await expect(page.locator("header").getByRole("status")).toHaveText("Live");
	const send = await connected.promise;

	return {
		viewRequests,
		frameRequests: () => frameRequests,
		beginTurn: () =>
			send({
				...snapshot,
				active: browsingTurn,
				preview: {
					runId: browsingTurn.runId,
					text: "",
					interrupted: [],
					tools: [
						{
							call: { role: "tool-call", id: "exec", name: "exec", input: {} },
							activity: [
								{
									id: "navigation",
									name: "browserNavigate",
									category: "browser",
									status: "running",
								},
							],
						},
					],
				},
			}),
		finishTurn: async (id: string) => send({ ...snapshot, browserWatch: await watch(id) }),
		setBrowser: async (id: string | null) =>
			send({ type: "browser", browserWatch: id ? await watch(id) : null }),
	};
}

test("opens the browser in a mobile sheet and docks it on wide screens", async ({ page }) => {
	const browser = await mockLiveBrowser(page);
	const browserId = "browser-one";
	const footer = page.locator("footer");
	const scroller = page.locator(".chat-transcript");
	const latestReply = page.getByRole("main").getByText("Earlier reply 24", { exact: true });
	const distanceFromBottom = () =>
		scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
	const scrollTop = () => scroller.evaluate((el) => el.scrollTop);
	const footerHeight = () => footer.evaluate((el) => el.getBoundingClientRect().height);
	await expect(latestReply).toBeAttached();
	await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
	await expect(footer.getByRole("status")).toHaveCount(0);
	const idleHeight = await footerHeight();
	browser.beginTurn();
	await expect(footer.getByRole("status")).toHaveText("Browsing");
	const statusChip = await chipGeometry(footer.getByRole("status"));
	expect(statusChip.radius * 2).toBeCloseTo(statusChip.height, 0);
	const connectionBadge = await chipGeometry(page.locator("header").getByRole("status"));
	expect(connectionBadge.radius * 2).toBeCloseTo(connectionBadge.height, 0);
	await expect(footer.getByRole("button", { name: "Browsing" })).toHaveCount(0);
	await browser.setBrowser(browserId);
	await expect(footer.getByRole("button", { name: "Browsing" })).toBeEnabled();
	await browser.finishTurn(browserId);
	const trigger = footer.getByRole("button", { name: "Browser open" });
	await expect(trigger).toBeVisible();
	expect(await chipGeometry(trigger)).toEqual(statusChip);
	await expect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
	const chipBox = (await trigger.boundingBox())!;
	const composerBox = (await footer.locator("form").boundingBox())!;
	expect(chipBox.y + chipBox.height).toBeLessThan(composerBox.y);
	expect(
		Math.abs(chipBox.x + chipBox.width / 2 - (composerBox.x + composerBox.width / 2)),
	).toBeLessThan(1);
	expect(await latestReply.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThan(
		chipBox.y,
	);

	await scroller.evaluate((el) => {
		el.scrollTop = 48;
	});
	await expect.poll(scrollTop).toBe(48);
	await expect(trigger).toBeInViewport();
	await browser.setBrowser(null);
	await expect(trigger).toHaveCount(0);
	await expect.poll(footerHeight).toBe(idleHeight);
	expect(await scrollTop()).toBe(48);
	await browser.setBrowser(browserId);
	await expect(trigger).toBeInViewport();
	expect(await scrollTop()).toBe(48);
	expect(browser.viewRequests).toEqual([]);
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "Live browser" });
	const iframe = dialog.locator("iframe");
	await expect(iframe.contentFrame().getByRole("heading", { name: "Browser page" })).toBeVisible();
	const closeButton = await chipGeometry(
		dialog.getByRole("button", { name: "Close live browser view" }),
	);
	expect(closeButton.radius * 2).toBeCloseTo(closeButton.height, 0);
	await expect(dialog).toHaveAttribute("aria-modal", "true");
	expect(await dialog.boundingBox()).toMatchObject({ x: 0, y: 0, ...page.viewportSize() });
	expect(browser.viewRequests).toEqual([browserId]);

	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(page.getByRole("textbox", { name: "Message Trajan" })).toBeVisible();
	await expect.poll(async () => (await dialog.boundingBox())?.x).toBeGreaterThan(700);
	expect((await dialog.boundingBox())?.height).toBeCloseTo(900, 0);
	await expect(iframe.contentFrame().getByRole("heading", { name: "Browser page" })).toBeVisible();
	expect(browser.viewRequests).toEqual([browserId]);
	expect(browser.frameRequests()).toBe(1);
});

test("replaces a closed browser and renews its lease after expiry", async ({ page }) => {
	await page.clock.install();
	const browser = await mockLiveBrowser(page);
	const trigger = page.getByRole("button", { name: "Browser open" });
	const dialog = page.getByRole("dialog", { name: "Live browser" });
	const iframe = dialog.locator("iframe");
	const browserPage = iframe.contentFrame().getByRole("heading", { name: "Browser page" });

	await browser.setBrowser("browser-one");
	await trigger.click();
	await expect(browserPage).toBeVisible();
	expect(browser.viewRequests).toEqual(["browser-one"]);

	await browser.setBrowser(null);
	await expect(dialog.getByRole("status")).toHaveText("Browser closed");
	await expect(iframe).toHaveCount(0);
	await browser.setBrowser("browser-two");
	await expect(browserPage).toBeVisible();
	expect(browser.viewRequests).toEqual(["browser-one", "browser-two"]);

	const reconnect = dialog.getByRole("button", { name: "Reconnect live view" });
	await expect(reconnect).toBeHidden();
	await page.clock.fastForward(viewLeaseMs + 1);
	await expect(reconnect).toBeVisible();
	await expect(browserPage).toBeVisible();
	expect(browser.viewRequests).toEqual(["browser-one", "browser-two"]);

	await reconnect.click();
	await expect(reconnect).toBeHidden();
	await expect(browserPage).toBeVisible();
	expect(browser.viewRequests).toEqual(["browser-one", "browser-two", "browser-two"]);
	await browser.setBrowser(null);
	await expect(dialog.getByRole("status")).toHaveText("Browser closed");
	await dialog.getByRole("button", { name: "Close live browser view" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toHaveCount(0);
});
