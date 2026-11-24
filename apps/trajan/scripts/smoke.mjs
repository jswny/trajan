import { stdout } from "node:process";
import assert from "node:assert/strict";
import { applyImmutable } from "@earendil-works/chord/delta";
import { MAIN_CHAT_PATH } from "../src/main-chat.ts";

const base = new URL(process.argv[2]);
const health = await fetch(new URL("/api/health", base));
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, service: "trajan" });
const marker = `trajan-smoke-${crypto.randomUUID()}`;
// Use isolated local state. The smoke prompts become part of its main chat.
const url = new URL(MAIN_CHAT_PATH, base);
const file = `/workspace/${marker}.txt`;
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

function connect(prompt, expectedTools) {
	return new Promise((resolve, reject) => {
		let view;
		const socket = new WebSocket(url);
		const timer = setTimeout(() => finish(new Error("Timed out waiting for Pi")), 180_000);
		function finish(error) {
			clearTimeout(timer);
			socket.close();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
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
				if (message.type === "error") {
					throw new Error(message.message);
				}
				if (message.type === "view") {
					view = message.view;
				} else if (message.type === "ops" && view) {
					view = applyImmutable(view, message.ops);
				} else {
					return;
				}
				const live = view.docs["pi.live"] ?? {};
				if (live.runFailure) {
					throw new Error(JSON.stringify(live.runFailure));
				}
				const messages = view.entries.flatMap((entry) => entry.model ?? []);
				const text =
					messages
						.filter((m) => m.role === "assistant")
						.at(-1)
						?.content.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("") ?? "";
				const tools = new Set(
					messages
						.filter(
							(m) =>
								m.role === "toolResult" &&
								!m.isError &&
								(m.toolName !== "codemode" ||
									m.content.some((part) => part.type === "text" && part.text.includes(marker))),
						)
						.map((m) => m.toolName),
				);
				if (
					live.run === undefined &&
					text.includes(marker) &&
					expectedTools.every((t) => tools.has(t))
				) {
					finish();
				}
			} catch (error) {
				finish(error);
			}
		});
	});
}

await connect(
	`Use write to save exactly ${marker} to ${file}, then use read to read that file back. Reply only with the file contents.`,
	["write", "read"],
);
stdout.write("Passed: Workers AI, Pi tool loop, durable workspace write/read\n");
await connect(undefined, ["write", "read"]);
stdout.write("Passed: WebSocket reconnect restores the conversation\n");
const command = `import { readFile } from "node:fs/promises"; export default async function () { return await readFile(${JSON.stringify(file)}, "utf8"); }`;
const code = `return await tools.exec({ command: ${JSON.stringify(command)} });`;
await connect(`Run this script with codemode and reply only with the file contents:\n${code}`, [
	"codemode",
]);
stdout.write("Passed: Pi Code Mode calling Cloudflare Computer exec\n");
stdout.write(`Verified ${base.origin}\n`);
