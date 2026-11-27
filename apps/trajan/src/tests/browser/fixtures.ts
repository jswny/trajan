import { expect, test as base } from "@playwright/test";

export { expect };

export const test = base.extend<{ fixtureCookie: void }, { fixtureURL: string }>({
	fixtureURL: [
		// oxlint-disable-next-line eslint/no-empty-pattern -- Playwright requires a destructured fixture argument.
		async ({}, provide) => {
			const port = process.env.TRAJAN_BROWSER_PORT;
			if (!port) {
				throw new Error("The local browser fixture did not report a port.");
			}
			const origin = `http://127.0.0.1:${port}`;
			await expect
				.poll(async () => {
					const response = await fetch(`${origin}/__browser-smoke/ready`).catch(() => undefined);
					return response?.ok ? response.text() : undefined;
				})
				.toBe("Trajan browser fixture");
			await provide(origin);
		},
		{ scope: "worker" },
	],
	baseURL: async ({ fixtureURL }, provide) => provide(fixtureURL),

	fixtureCookie: [
		async ({ context, fixtureURL }, provide) => {
			await context.addCookies([
				{ name: "trajan-fixture", value: crypto.randomUUID(), url: fixtureURL, httpOnly: true },
			]);
			await provide();
		},
		{ auto: true },
	],
});
