import { env } from "cloudflare:workers";
import { expect, test } from "vite-plus/test";

function openFixture() {
	return env.EFFECT_HARNESS_TEST.getByName(crypto.randomUUID());
}

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
		stub = env.EFFECT_HARNESS_TEST.get(stub.id);
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

test("retries an unfinished safe call with the same operation ID after a reset", async () => {
	let stub = openFixture();
	await stub.seedCodeMode();
	await stub.pause("code-mode-read");
	const source = `
import { read } from "codemode:tools";
export default async function () {
  return await Promise.all([read({ label: "before" }), read({ label: "retry" })]);
}`;
	const pending = expect(stub.runCodeMode("run", source)).rejects.toThrow(/restart|reset/i);
	await expect.poll(() => stub.codeModeState()).toMatchObject({ pausedAt: "code-mode-read" });
	const { receipts } = await stub.codeModeState();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	await pending;
	stub = env.EFFECT_HARNESS_TEST.get(stub.id);
	await stub.release();

	await expect(stub.runCodeMode("run", source)).resolves.toEqual({ value: ["seed", "seed"] });
	const after = await stub.codeModeState();
	expect(receipts.retry).toHaveLength(1);
	expect(after.receipts.before).toEqual(receipts.before);
	expect(after.receipts.retry).toEqual([receipts.retry?.[0], receipts.retry?.[0]]);
});

test("stops a divergent replay before it can perform a new mutation", async () => {
	let stub = openFixture();
	await stub.seedCodeMode();
	await stub.pause("code-mode-read");
	const source = `
import { read, edit } from "codemode:tools";
export default async function () {
  try {
    await read({ label: crypto.randomUUID() });
    return await read({ label: "retry" });
  } catch (error) {
    if (error.code !== "failed") throw error;
    try {
      await edit({ oldText: "seed", newText: "unexpected" });
    } catch (blocked) {
      if (blocked.code !== "failed") throw blocked;
    }
    return "caught";
  }
}`;
	const pending = expect(stub.runCodeMode("run", source)).rejects.toThrow(/restart|reset/i);
	await expect.poll(() => stub.codeModeState()).toMatchObject({ pausedAt: "code-mode-read" });
	const before = await stub.codeModeState();
	await expect(stub.crash()).rejects.toThrow(/restart|reset/i);
	await pending;
	stub = env.EFFECT_HARNESS_TEST.get(stub.id);
	await stub.release();

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
	const result = await stub.runCodeMode(
		"network",
		`export default async function () {
  try {
    await fetch("https://example.com");
    return "allowed";
  } catch (error) {
    return error.message;
  }
}`,
	);
	expect(result).toEqual({
		value: expect.stringContaining("not permitted to access the internet"),
	});
});
