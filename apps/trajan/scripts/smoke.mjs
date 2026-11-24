import assert from "node:assert/strict";
import { stdout } from "node:process";

const base = new URL(process.argv[2]);
const health = await fetch(new URL("/api/health", base));
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, service: "trajan" });
const marker = `trajan-smoke-${crypto.randomUUID()}`;
const file = `/workspace/${marker}.txt`;
const socketUrl = new URL("/api/chat/live", base);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

function watch(accept) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(socketUrl);
		const timeout = setTimeout(() => finish(new Error("Timed out waiting for Trajan")), 180_000);
		function finish(error, value) {
			clearTimeout(timeout);
			socket.close();
			if (error) {
				reject(error);
			} else {
				resolve(value);
			}
		}
		socket.addEventListener("error", () => finish(new Error("Chat WebSocket failed")));
		socket.addEventListener("message", ({ data }) => {
			try {
				const event = JSON.parse(String(data));
				const value = accept(event);
				if (value !== undefined) {
					finish(null, value);
				}
			} catch (error) {
				finish(error);
			}
		});
	});
}

async function send(prompt, tools) {
	const id = crypto.randomUUID();
	let deltas = 0;
	const ready = Promise.withResolvers();
	const completion = watch((event) => {
		if (event.type === "text-delta") {
			deltas += 1;
		}
		if (event.type !== "snapshot") {
			return;
		}
		ready.resolve();
		const messages = event.page.entries
			.filter((entry) => entry.submissionId === id)
			.map((entry) => entry.message);
		const reply = messages.at(-1);
		if (!reply && event.active === null && event.error) {
			throw new Error(event.error);
		}
		if (reply?.role !== "assistant") {
			return;
		}
		for (const tool of tools) {
			const call = messages.find(
				(message) => message.role === "tool-call" && message.name === tool,
			);
			assert.ok(call, `The model did not call ${tool}`);
			assert.ok(
				messages.some(
					(item) =>
						item.role === "tool" && item.callId === call.id && item.result.status === "completed",
				),
				`The ${tool} call did not complete`,
			);
		}
		assert.ok(reply.text.includes(marker), "The reply did not include the workspace marker");
		return deltas;
	});
	await Promise.race([ready.promise, completion]);
	const response = await fetch(new URL("/api/chat", base), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id, prompt }),
	});
	assert.equal(response.status, 202);
	assert.equal((await response.json()).submissionId, id);
	const streamed = await completion;
	assert.ok(streamed > 0, "The model did not stream text");
	stdout.write(`Passed: ${tools.join(", ")} with ${streamed} streamed text updates\n`);
	return id;
}

const first = await send(
	`Use write to save exactly ${marker} to ${file}, then use read to read that file back. Reply only with the file contents.`,
	["write", "read"],
);
const restored = await watch((event) =>
	event.type === "snapshot" ? event.page.entries : undefined,
);
assert.ok(
	restored.some(
		(entry) =>
			entry.submissionId === first &&
			entry.message.role === "assistant" &&
			entry.message.text.includes(marker),
	),
);
stdout.write("Passed: WebSocket reconnect restores the conversation\n");
const command = `import { readFile } from "node:fs/promises"; export default async function () { return await readFile(${JSON.stringify(file)}, "utf8"); }`;
const code = `return await tools.exec({ command: ${JSON.stringify(command)} });`;
await send(`Run this script with codemode and reply only with the file contents:\n${code}`, [
	"codemode",
]);
stdout.write(`Verified ${base.origin}\n`);
