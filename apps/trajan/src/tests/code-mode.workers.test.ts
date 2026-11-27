import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vite-plus/test";

function openFixture() {
	return env.CHAT_TEST.getByName(crypto.randomUUID());
}

test("a workspace transaction rollback keeps concurrent receipts and other transactions", async () => {
	const stub = openFixture();
	const result = await runInDurableObject(stub, async (_, { storage }) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const rejected = storage.transaction(async (txn) => {
			storage.kv.put("transaction-check:rejected", true);
			entered.resolve();
			await release.promise;
			txn.rollback();
		});
		await entered.promise;
		const receipt = storage.transaction(async () =>
			storage.kv.put("transaction-check:receipt", true),
		);
		const committed = storage.transaction(async () =>
			storage.kv.put("transaction-check:committed", true),
		);
		release.resolve();
		await Promise.all([rejected, committed, receipt]);
		return Array.from(storage.kv.list({ prefix: "transaction-check:" }), ([key]) => key);
	});
	expect(result).toEqual(["transaction-check:committed", "transaction-check:receipt"]);
});

test("parallel workspace edits preserve separate receipts and retain both changes on a shared path", async () => {
	const stub = openFixture();
	const result = await stub.workspaceTool("exec", {
		code: `
import { edit, read, write } from "codemode:tools";
export default async function () {
  const first = "/workspace/a.txt";
  const second = "/workspace/b.txt";
  await Promise.all([
    write({ path: first, content: "red circle" }),
    write({ path: second, content: "green triangle" }),
  ]);
  const [a, b, c] = await Promise.all([
    edit({ path: first, edits: [{ oldText: "red", newText: "blue" }] }),
    edit({ path: second, edits: [{ oldText: "triangle", newText: "square" }] }),
    edit({ path: first, edits: [{ oldText: "circle", newText: "diamond" }] }),
  ]);
  const values = await Promise.all([read({ path: first }), read({ path: second })]);
  return { edits: [a, b, c], values: values.map(({ details }) => details.content) };
}`,
	});
	expect(JSON.parse(result)).toMatchObject({
		status: "completed",
		output: {
			edits: [
				{ isError: false, details: { path: "/workspace/a.txt" } },
				{ isError: false, details: { path: "/workspace/b.txt" } },
				{ isError: false, details: { path: "/workspace/a.txt" } },
			],
			values: ["blue diamond", "green square"],
		},
		activity: expect.arrayContaining([
			expect.objectContaining({
				name: "edit",
				fileChange: expect.objectContaining({
					path: "/workspace/a.txt",
					diff: expect.stringContaining("blue"),
				}),
			}),
			expect.objectContaining({
				name: "edit",
				fileChange: expect.objectContaining({
					path: "/workspace/b.txt",
					diff: expect.stringContaining("green square"),
				}),
			}),
		]),
	});
});

test("holds Code Mode ownership until an interrupted mutation settles", async () => {
	const stub = openFixture();
	const source = `
import { settle } from "codemode:tools";
export default async function () {
  try { await settle(); }
  catch (error) { return error.code; }
  return "completed";
}`;
	await stub.pause("code-mode-settle");
	const pending = stub.runCodeMode("settling", source, true);
	try {
		await expect.poll(() => stub.codeModeState()).toMatchObject({ pausedAt: "code-mode-settle" });
		await stub.interruptCodeMode();
		await expect(stub.runCodeMode("settling", source)).resolves.toEqual({
			error: "This script is already running.",
		});
		await expect(stub.runCodeMode("other", "export default () => 1")).resolves.toEqual({
			error: "An interrupted tool is still settling.",
		});
	} finally {
		await stub.release();
		await expect(pending).resolves.toMatchObject({ error: expect.stringMatching(/interrupt/i) });
	}
	await expect.poll(() => stub.runCodeMode("settling", source)).toEqual({ value: "interrupted" });
	expect((await stub.codeModeState()).receipts.settle).toHaveLength(1);
	await expect(stub.runCodeMode("other", "export default () => 1")).resolves.toEqual({ value: 1 });
});

test("rejects malformed run and call checkpoints without invoking a tool", async () => {
	const stub = openFixture();
	const source = `
import { settle } from "codemode:tools";
export default async function () {
  try { await settle(); } catch {}
  return "completed";
}`;
	await runInDurableObject(stub, (_, { storage }) => {
		storage.kv.put("code-mode:bad-run:bad-run", { source, result: {} });
		const key = "code-mode:bad-call:bad-call";
		storage.kv.put(key, { source });
		storage.kv.put(`${key}:call:0`, {
			request: JSON.stringify({ module: "codemode:tools", name: "settle", input: null }),
			replay: "unsafe",
			reply: { status: "returned" },
		});
	});
	await expect(stub.runCodeMode("bad-run", source)).resolves.toEqual({
		error: "Invalid Code Mode run checkpoint.",
	});
	await expect(stub.runCodeMode("bad-call", source)).resolves.toEqual({
		error: "Invalid Code Mode checkpoint for call 1.",
	});
	expect((await stub.codeModeState()).receipts.settle).toBeUndefined();
});

const recoverCase = [
	{
		name: "an interrupted edit",
		pause: "code-mode-edit",
		operation: "edit",
		expected: { text: "seed!" },
		source: `
import { read, edit } from "codemode:tools";
export default async function () {
  const before = await read({ label: "before" });
  let outcome = "completed";
  try {
    await edit({ oldText: "seed", newText: "seed!" });
  } catch (error) {
    if (error.code !== "interrupted") throw error;
    outcome = error.code;
  }
  return { before, outcome, text: await read({ label: "after" }) };
}`,
	},
	{
		name: "interrupted Git branch creation",
		pause: "code-mode-branch",
		operation: "branch",
		expected: { branchExists: true },
		source: `
import { read } from "codemode:tools";
import { branch, branches } from "codemode:git";
export default async function () {
  const before = await read({ label: "before" });
  let outcome = "completed";
  try {
    await branch();
  } catch (error) {
    if (error.code !== "interrupted") throw error;
    outcome = error.code;
  }
  return { before, outcome, branchExists: (await branches()).includes("code-mode-proof") };
}`,
	},
] as const;

test.each(recoverCase)(
	"replays completed calls and reports $name after a reset",
	async (scenario) => {
		let stub = openFixture();
		await stub.seedCodeMode();
		await stub.pause(scenario.pause);
		const pending = expect(stub.runCodeMode("run", scenario.source)).rejects.toThrow(
			/restart|reset/i,
		);
		await expect.poll(() => stub.codeModeState()).toMatchObject({ pausedAt: scenario.pause });
		const beforeReset = await stub.codeModeState();
		await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
		await pending;
		stub = env.CHAT_TEST.get(stub.id);
		await stub.release();

		const expected = { before: "seed", outcome: "interrupted", ...scenario.expected };
		await expect(stub.runCodeMode("run", scenario.source)).resolves.toEqual({ value: expected });
		await expect(stub.runCodeMode("run", scenario.source)).resolves.toEqual({ value: expected });
		const afterReset = await stub.codeModeState();
		expect(afterReset.instance).not.toBe(beforeReset.instance);
		expect(afterReset.receipts.before).toEqual(beforeReset.receipts.before);
		expect(afterReset.receipts.before).toHaveLength(1);
		expect(afterReset.receipts[scenario.operation]).toHaveLength(1);
		await expect(stub.runCodeMode("run", "export default () => 1")).resolves.toEqual({
			error: expect.stringContaining("different script"),
		});
	},
);

test("replays out-of-order delivery and retries the unfinished call with the same ID", async () => {
	let stub = openFixture();
	await stub.seedCodeMode();
	await stub.pause("code-mode-read");
	const source = `
import { read } from "codemode:tools";
export default async function () {
  const slow = read({ label: "retry" }).then(() => "slow");
  const fast = read({ label: "before" }).then(() => "fast");
  const winner = await Promise.race([slow, fast]);
  await read({ label: "winner-" + winner });
  await read({ label: "sample:" + Date.now() + ":" + Math.random() });
  return { winner, results: await Promise.all([slow, fast]) };
}`;
	const pending = expect(stub.runCodeMode("run", source)).rejects.toThrow(/restart|reset/i);
	await expect
		.poll(() => stub.codeModeState())
		.toMatchObject({
			pausedAt: "code-mode-read",
			receipts: { "winner-fast": [expect.any(String)] },
		});
	await expect
		.poll(async () =>
			Object.keys((await stub.codeModeState()).receipts).some((key) => key.startsWith("sample:")),
		)
		.toBe(true);
	const { receipts } = await stub.codeModeState();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	await pending;
	stub = env.CHAT_TEST.get(stub.id);
	await stub.release();

	await expect(stub.runCodeMode("run", source)).resolves.toEqual({
		value: { winner: "fast", results: ["slow", "fast"] },
	});
	const after = await stub.codeModeState();
	expect(receipts.retry).toHaveLength(1);
	expect(after.receipts.before).toEqual(receipts.before);
	expect(after.receipts["winner-fast"]).toEqual(receipts["winner-fast"]);
	const samples = Object.entries(receipts).filter(([key]) => key.startsWith("sample:"));
	expect(samples).toHaveLength(1);
	expect(after.receipts).toMatchObject(Object.fromEntries(samples));
	expect(after.receipts.retry).toEqual([receipts.retry?.[0], receipts.retry?.[0]]);
});

test("replays a completed page read and leaves interrupted navigation alone", async () => {
	let stub = openFixture();
	const start = "https://example.com/";
	const next = "https://example.com/next";
	await expect(
		stub.runCodeMode(
			"open",
			`
import { browserNavigate } from "codemode:tools";
export default () => browserNavigate({ url: ${JSON.stringify(start)} });
`,
		),
	).resolves.toEqual({ value: { requestedUrl: start } });
	const source = `
import { browserNavigate, browserRead } from "codemode:tools";
export default async function () {
  const before = await browserRead({});
  let outcome = "completed";
  try {
    await browserNavigate({ url: ${JSON.stringify(next)} });
  } catch (error) {
    if (error.code !== "interrupted") throw error;
    outcome = error.code;
  }
  const after = await browserRead({});
  return { before: before.url, after: after.url, outcome };
}`;
	await stub.pause("code-mode-browser");
	const pending = expect(stub.runCodeMode("browse", source)).rejects.toThrow(/restart|reset/i);
	await expect.poll(() => stub.codeModeState()).toMatchObject({ pausedAt: "code-mode-browser" });
	const beforeReset = await stub.codeModeState();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	await pending;
	stub = env.CHAT_TEST.get(stub.id);
	await stub.release();
	await expect(stub.runCodeMode("browse", source)).resolves.toEqual({
		value: { before: start, after: next, outcome: "interrupted" },
	});
	const afterReset = await stub.codeModeState();
	expect(afterReset.instance).not.toBe(beforeReset.instance);
	expect(afterReset.receipts.browserNavigate).toEqual(beforeReset.receipts.browserNavigate);
	expect(afterReset.receipts.browserRead).toHaveLength(2);
});

test("bounds browser screenshots and reports a lost page after closing", async () => {
	const stub = openFixture();
	await expect(
		stub.runCodeMode(
			"capture",
			`
import { browserNavigate, browserScreenshot, browserClose } from "codemode:tools";
export default async function () {
  await browserNavigate({ url: "https://example.com/" });
  const image = await browserScreenshot({});
  const { closed } = await browserClose({});
  return { closed, image };
}`,
		),
	).resolves.toEqual({
		value: { closed: true, image: [{ type: "image", mimeType: "image/jpeg", data: "/9j/" }] },
	});
	await expect(
		stub.runCodeMode(
			"closed",
			`
import { browserRead } from "codemode:tools";
export default () => browserRead({});
`,
		),
	).resolves.toEqual({ error: expect.stringContaining("The browser lost its previous page") });
});

test("stops a divergent replay before it can perform a new mutation", async () => {
	let stub = openFixture();
	await stub.seedCodeMode();
	await stub.pause("code-mode-read");
	const source = `
import { read, edit } from "codemode:tools";
export default async function () {
  await read({ label: "retry" });
  await edit({ oldText: "seed", newText: "unexpected" });
  return "unexpected";
}`;
	const pending = expect(stub.runCodeMode("run", source)).rejects.toThrow(/restart|reset/i);
	await expect.poll(() => stub.codeModeState()).toMatchObject({ pausedAt: "code-mode-read" });
	const before = await stub.codeModeState();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	await pending;
	stub = env.CHAT_TEST.get(stub.id);
	await stub.release();
	await runInDurableObject(stub, (_, { storage }) => {
		storage.kv.put("code-mode:run:run:call:0", {
			request: JSON.stringify({
				module: "codemode:tools",
				name: "read",
				input: { label: "different" },
			}),
			replay: "safe",
		});
	});

	await expect(stub.runCodeMode("run", source)).resolves.toEqual({
		error: "Code Mode replay diverged at call 1.",
	});
	expect((await stub.codeModeState()).receipts).toEqual(before.receipts);
});

test("rejects direct filesystem and shell imports and denies outbound network access", async () => {
	const stub = openFixture();
	for (const module of ["node:fs/promises", "node:child_process", "codemode:exec"]) {
		await expect(
			stub.runCodeMode(
				module,
				`export default async function () {
  try {
    await import(${JSON.stringify(module)});
    return "allowed";
  } catch (error) {
    return error.message;
  }
}`,
			),
		).resolves.toEqual({ value: expect.stringMatching(/module/i) });
	}
	await expect(
		stub.runCodeMode("network", "export default () => typeof globalThis.fetch;"),
	).resolves.toEqual({ value: "undefined" });
});
test("uses registered namespace imports alongside ordinary module bindings", async () => {
	const stub = openFixture();
	await expect(
		stub.runCodeMode(
			"namespace",
			`
import * as runtime from "codemode:runtime";
const Object = "local";
export default async () => Object + ":" + typeof await runtime.now();
`,
		),
	).resolves.toEqual({ value: "local:number" });
});

test("bounds CPU-only scripts in the sandbox and accepts the next script", async () => {
	const stub = openFixture();
	await expect(
		stub.runCodeMode("compute", "export default () => { for (;;) {} }"),
	).resolves.toEqual({
		error: expect.stringMatching(/interrupt|budget|timed out/i),
	});
	await expect(stub.runCodeMode("next", "export default () => 42")).resolves.toEqual({ value: 42 });
});

test("returns a committed call result even if activity publication fails", async () => {
	const stub = env.CHAT_TEST.getByName(crypto.randomUUID());
	await stub.seedCodeMode();
	const source = `
import { read } from "codemode:tools";
export default () => read({ label: "published" });
`;
	await expect(stub.runCodeMode("activity", source, false, true)).resolves.toEqual({
		value: "seed",
	});
	await expect(stub.runCodeMode("activity", source)).resolves.toEqual({ value: "seed" });
	expect((await stub.codeModeState()).receipts.published).toHaveLength(1);
});
