import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import { BrowserViewPath } from "../../chat/protocol";
import type { ChatSnapshot } from "../../chat/protocol";

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

test("opens the browser in a mobile sheet and docks it on wide screens", async ({ page }) => {
	let setBrowser: ((id: string | null) => void) | undefined;
	let beginTurn: (() => void) | undefined;
	let finishTurn: (() => void) | undefined;
	let expectedBrowser = "browser-one";
	let viewRequests = 0;
	await page.routeWebSocket("**/api/chat/live", (client) => {
		const snapshot = {
			type: "snapshot",
			page: { entries: history, nextBefore: null },
			queued: 0,
			catalog: [],
			active: null,
			preview: null,
			browserWatch: null,
		} satisfies typeof ChatSnapshot.Type;
		client.send(JSON.stringify(snapshot));
		beginTurn = () =>
			client.send(
				JSON.stringify({
					...snapshot,
					active: browsingTurn,
					preview: {
						runId: browsingTurn.runId,
						text: "",
						tools: [
							{
								call: { role: "tool-call", id: "exec", name: "exec", input: {} },
								activity: [{ id: "navigation", name: "browserNavigate", status: "running" }],
							},
						],
					},
				} satisfies typeof ChatSnapshot.Type),
			);
		finishTurn = () =>
			client.send(
				JSON.stringify({
					...snapshot,
					active: null,
					preview: null,
					browserWatch: { id: expectedBrowser, expiresAt: Date.now() + 120_000 },
				}),
			);
		setBrowser = (id) =>
			client.send(
				JSON.stringify({
					type: "browser",
					browserWatch: id ? { id, expiresAt: Date.now() + 120_000 } : null,
				}),
			);
	});
	await page.route(`**${BrowserViewPath}`, (route) => {
		expect(route.request().method()).toBe("POST");
		expect(route.request().postDataJSON()).toEqual({ id: expectedBrowser });
		viewRequests += 1;
		return route.fulfill({ json: { status: "open", url: hostedView } });
	});
	await page.route(hostedView, (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>Browser page</h1>" }),
	);
	await page.goto("/");
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
	beginTurn?.();
	await expect(footer.getByRole("status")).toHaveText("Browsing");
	const statusChip = await chipGeometry(footer.getByRole("status"));
	expect(statusChip.radius * 2).toBe(statusChip.height);
	const connectionBadge = await chipGeometry(page.locator("header").getByRole("status"));
	expect(connectionBadge.radius * 2).toBe(connectionBadge.height);
	await expect(footer.getByRole("button", { name: "Browsing" })).toHaveCount(0);
	setBrowser?.(expectedBrowser);
	await expect(footer.getByRole("button", { name: "Browsing" })).toBeEnabled();
	finishTurn?.();
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
	setBrowser?.(null);
	await expect(trigger).toHaveCount(0);
	await expect.poll(footerHeight).toBe(idleHeight);
	expect(await scrollTop()).toBe(48);
	setBrowser?.(expectedBrowser);
	await expect(trigger).toBeInViewport();
	expect(await scrollTop()).toBe(48);
	expect(viewRequests).toBe(0);
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "Live browser" });
	const iframe = dialog.locator("iframe");
	await expect(iframe.contentFrame().getByRole("heading", { name: "Browser page" })).toBeVisible();
	const closeButton = await chipGeometry(
		dialog.getByRole("button", { name: "Close live browser view" }),
	);
	expect(closeButton.radius * 2).toBe(closeButton.height);
	await expect(dialog).toHaveAttribute("aria-modal", "true");
	expect(await dialog.boundingBox()).toMatchObject({ x: 0, y: 0, ...page.viewportSize() });
	expect(viewRequests).toBe(1);

	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(page.getByRole("textbox", { name: "Message Trajan" })).toBeVisible();
	const panelBox = await dialog.boundingBox();
	expect(panelBox?.x).toBeGreaterThan(700);
	expect(panelBox?.height).toBe(900);
	expect(viewRequests).toBe(1);

	setBrowser?.(null);
	await expect(dialog.getByRole("status")).toHaveText("Browser closed");
	await expect(iframe).toHaveCount(0);
	expectedBrowser = "browser-two";
	setBrowser?.(expectedBrowser);
	await expect.poll(() => viewRequests).toBe(2);
	await expect(iframe.contentFrame().getByRole("heading", { name: "Browser page" })).toBeVisible();
	setBrowser?.(null);
	await dialog.getByRole("button", { name: "Close live browser view" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toHaveCount(0);
});
