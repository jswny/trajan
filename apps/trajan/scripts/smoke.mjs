import assert from "node:assert/strict";
import { stdout } from "node:process";

const base = new URL(process.argv[2]);
const health = await fetch(new URL("/api/health", base));
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, service: "trajan" });
const marker = `trajan-smoke-${crypto.randomUUID()}`;
const file = `/workspace/${marker}.txt`;
const socketUrl = new URL("/api/agents/trajan/main", base);
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

async function send(prompt) {
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
		assert.deepEqual(
			event.catalog.map(({ name }) => name),
			["exec"],
		);
		ready.resolve();
		const messages = event.page.entries
			.filter((entry) => entry.submissionId === id)
			.map((entry) => entry.message);
		const reply = messages.at(-1);
		if (reply?.role === "notice") {
			throw new Error(reply.text);
		}
		if (reply?.role !== "assistant") {
			return;
		}
		const calls = messages.filter((message) => message.role === "tool-call");
		assert.ok(calls.length > 0 && calls.every((call) => call.name === "exec"));
		assert.ok(
			calls.some((call) => call.input.code.includes("codemode:tools")) &&
				messages.some(
					(item) =>
						item.role === "tool" &&
						item.result.status === "completed" &&
						JSON.stringify(item.result.output).includes(marker),
				),
			"Expected Computer's registered tools to return the workspace marker",
		);
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
	stdout.write(`Passed: Computer read/write through exec with ${streamed} streamed text updates\n`);
	return id;
}

const code = `import { read, write } from "codemode:tools";
export default async function () {
  const written = await write({ path: ${JSON.stringify(file)}, content: ${JSON.stringify(marker)} });
  if (written.isError) throw new Error(written.text);
  const result = await read({ path: ${JSON.stringify(file)} });
  if (result.isError) throw new Error(result.text);
  return result.text;
}`;
const first = await send(
	`Run this exact JavaScript module using exec. Reply with only the marker you read from the file:\n${code}`,
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
stdout.write(`Verified ${base.origin}\n`);
