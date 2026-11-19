import assert from "node:assert/strict";
import { applyImmutable } from "@earendil-works/chord/delta";

const base = new URL(process.argv[2]);
const health = await fetch(new URL("/api/health", base));
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, service: "trajan" });
const marker = `trajan-smoke-${crypto.randomUUID()}`;
const url = new URL(`/agents/trajan/${crypto.randomUUID()}`, base);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

function connect(prompt, expectedTools) {
	return new Promise((resolve, reject) => {
		let view;
		const socket = new WebSocket(url);
		const timer = setTimeout(() => finish(new Error("Timed out waiting for Pi")), 180_000);
		function finish(error) {
			clearTimeout(timer);
			socket.close();
			if (error) reject(error);
			else resolve();
		}
		socket.addEventListener("error", () => finish(new Error("WebSocket failed")));
		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({ type: "watch" }));
			if (prompt) {
				const id = crypto.randomUUID();
				socket.send(JSON.stringify({ type: "submit", id, operationId: id, input: prompt }));
			}
		});
		socket.addEventListener("message", ({ data }) => {
			try {
				const message = JSON.parse(String(data));
				if (message.type === "error") throw new Error(message.message);
				if (message.type === "view") view = message.view;
				else if (message.type === "ops" && view) view = applyImmutable(view, message.ops);
				else return;
				const live = view.docs["pi.live"] ?? {};
				if (live.runFailure) throw new Error(JSON.stringify(live.runFailure));
				const messages = view.entries.flatMap((entry) => entry.model ?? []);
				const text =
					messages
						.filter((m) => m.role === "assistant")
						.at(-1)
						?.content.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("") ?? "";
				const tools = messages
					.filter((m) => m.role === "toolResult" && !m.isError)
					.map((m) => m.toolName);
				if (
					live.run === undefined &&
					text.includes(marker) &&
					expectedTools.every((t) => tools.includes(t))
				)
					finish();
			} catch (error) {
				finish(error);
			}
		});
	});
}

await connect(
	`Use write to save exactly ${marker} to /workspace/smoke.txt, then use read to read that file back. Reply only with the file contents.`,
	["write", "read"],
);
console.log("Passed: Workers AI, Pi tool loop, durable workspace write/read");
await connect(undefined, ["write", "read"]);
console.log("Passed: WebSocket reconnect restores the conversation");
await connect(
	'Use exec to run this JavaScript ES module: import { readFile } from "node:fs/promises"; export default async function () { return await readFile("/workspace/smoke.txt", "utf8"); } Reply only with its result.',
	["exec"],
);
console.log("Passed: Dynamic Worker JavaScript execution");
console.log(`Verified ${base.origin}`);
