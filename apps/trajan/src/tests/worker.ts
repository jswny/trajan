export { EffectHarnessTestObject } from "./effect-harness-fixture";
import { serveEffectHarness } from "./effect-harness-fixture";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { num, obj } from "@earendil-works/pi-schema";
import { createModels } from "@earendil-works/pi-ai/models";
import { ConversationTranscript, createRegistry, Harness } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import type { PiOperationResult, PiReceipt, PiWhenBusy } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { Effect, Predicate } from "effect";
import { workspaceCodemode } from "../codemode";
import { isMainChatUrl } from "../main-chat";
import { PiSessionSockets } from "../sockets";
import { projectView } from "../view";
import { createWorkspaceTools } from "../workspace";

const RELEASE_KEY = "test:gate:release";
const GATE_RUNS_KEY = "test:gate:runs";
const CODEMODE_COUNT_PATH = "/workspace/codemode-count.txt";

function textOf(content: Message["content"] | undefined): string {
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/**
 * The faux model's script, derived from the transcript alone so it gives
 * the same answer after an eviction as before it:
 *
 * - `multiply N` calls `multiply`, `gate` calls `gate`, `gate-unsafe` calls
 *   `gate_unsafe`, `read PATH` calls the workspace's `read`; anything else
 *   is echoed back.
 * - After a tool result it answers `tool said: <result>`.
 */
function script(context: TranscriptContext): AssistantMessage {
	// pi places system-prompt changes positionally, so a system message can
	// follow the user's input.
	const last = context.messages.filter((m) => m.role !== "system").at(-1);
	if (last?.role === "toolResult") {
		return fauxAssistantMessage([
			fauxText(`${last.isError ? "tool failed" : "tool said"}: ${textOf(last.content)}`),
		]);
	}
	const prompt = last?.role === "user" ? textOf(last.content) : "";
	if (prompt === "codemode completed exec" || prompt === "codemode running exec") {
		const command = `
import fs from "node:fs/promises";
export default async function () {
  await fs.mkdir("/workspace", { recursive: true });
  const path = ${JSON.stringify(CODEMODE_COUNT_PATH)};
  const count = await fs.readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  await fs.writeFile(path, count + "x");
  ${prompt === "codemode running exec" ? "await new Promise((resolve) => setTimeout(resolve, 45_000));" : ""}
}`;
		const code = `await tools.exec({ command: ${JSON.stringify(command)} }); return await tools.gate({});`;
		return fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
	}
	const multiply = /^multiply (\d+)$/.exec(prompt);
	if (multiply) {
		return fauxAssistantMessage([fauxToolCall("multiply", { value: Number(multiply[1]) })], {
			stopReason: "toolUse",
		});
	}
	const read = /^read (\S+)$/.exec(prompt);
	if (read) {
		return fauxAssistantMessage([fauxToolCall("read", { path: read[1] })], {
			stopReason: "toolUse",
		});
	}
	if (prompt === "gate" || prompt === "gate browser recovery" || prompt === "gate-unsafe") {
		return fauxAssistantMessage(
			[fauxToolCall(prompt === "gate-unsafe" ? "gate_unsafe" : "gate", {})],
			{
				stopReason: "toolUse",
			},
		);
	}
	return fauxAssistantMessage([fauxText(`echo: ${prompt}`)]);
}

/** Real Durable Object fixture: the example's composition with pi-ai's faux provider. */
export class PiHarnessTestObject extends DurableObject<Env> {
	readonly #faux = fauxProvider({
		tokensPerSecond: 200,
		tokenSize: { min: 2, max: 4 },
	});
	// The example's workspace, over the object's SQLite.
	readonly workspace = new Workspace({
		storage: this.ctx.storage,
		backends: [
			new CodemodeBackend({
				loader: this.env.LOADER,
				root: "/workspace",
				access: "read-write",
			}),
		],
	});
	readonly registry = createRegistry();
	/** While set, pi does not open, as when its storage keeps failing. */
	#failOpens = false;
	readonly harness = new PiHarness({
		harness: async ({ storage, context, onWake }) => {
			if (this.#failOpens) {
				throw new Error("pi failed to open");
			}
			this.registry.install(this.#testTools());
			this.registry.install({
				name: "workspace",
				tools: createWorkspaceTools(this.workspace),
			});
			const sandbox = this.env.CODEMODE_SANDBOX;
			if (sandbox) {
				this.registry.install(workspaceCodemode(() => sandbox.getByName(this.ctx.id.toString())));
			}
			const models = createModels();
			models.setProvider(this.#faux.provider);
			return Harness.open(
				storage,
				{
					models,
					registry: this.registry,
					onWake,
					settings: {
						retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
						// Only `compact()` compacts, and it keeps little verbatim, so a
						// short transcript has something to summarize.
						compaction: { enabled: false, keepRecentTokens: 1 },
					},
					onReport: (report) => Effect.runSync(Effect.logWarning("pi report", report)),
				},
				context,
			);
		},
		defaults: { model: this.#faux.getModel() },
	});
	readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
		this.ctx.getWebSockets(tag),
	);
	readonly webSockets = new WebSockets(this.sockets.options());
	readonly lifecycle = Lifecycle.install(this).use(this.webSockets).use(this.harness);

	async onStart(): Promise<void> {
		await this.sockets.reattach();
	}

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#faux.setResponses(Array.from({ length: 200 }, () => script));
	}

	/** Prompt the root session; the result without its transcript. */
	async prompt(text: string): Promise<PiOperationResult> {
		const { messages: _messages, ...result } = await this.harness.prompt(text);
		return result;
	}

	submit(
		text: string,
		options: {
			whenBusy?: PiWhenBusy;
			session?: string;
			operationId?: string;
		} = {},
	): Promise<PiReceipt> {
		return this.harness.submit(text, options);
	}

	wait(operationId: string, session?: string): Promise<PiOperationResult> {
		return this.harness.wait(operationId, session ? { session } : {});
	}

	/** Reset the root session's context. */
	async reset(): Promise<void> {
		await this.harness.session().reset();
	}

	/** Write a file into the workspace, as a test's setup. */
	async writeWorkspaceFile(path: string, text: string): Promise<void> {
		await this.workspace.fs.mkdir("/workspace", { recursive: true });
		await this.workspace.fs.writeFile(path, text);
	}

	/** Resolve once the gate tool has started `runs` times. */
	async gateStarted(runs: number): Promise<number> {
		for (let i = 0; i < 200; i++) {
			const count = (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0;
			if (count >= runs) {
				return count;
			}
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});
		}
		throw new Error("The gate tool never started");
	}

	async release(): Promise<void> {
		await this.ctx.storage.put(RELEASE_KEY, true);
	}

	disconnect(): void {
		for (const socket of this.ctx.getWebSockets()) {
			socket.close(1012, "Lost submit receipt");
		}
	}

	crash(): void {
		this.ctx.abort("Forced browser fixture restart");
	}

	async codemodeState() {
		const contents = await this.workspace.fs
			.readFile(CODEMODE_COUNT_PATH, "utf8")
			.catch((error: unknown) => {
				if (Predicate.hasProperty(error, "code") && error.code === "ENOENT") {
					return "";
				}
				throw error;
			});
		return {
			executions: contents.length,
			gateRuns: (await this.ctx.storage.get<number>(GATE_RUNS_KEY)) ?? 0,
		};
	}

	/** Watch the root session through one run: the view projected from its last value. */
	async watch(): Promise<string> {
		const watch = await this.harness.session().watch();
		const transcript = this.#transcript();
		let sawRun = false;
		let view = projectView(transcript.merge(watch.value));
		await new Promise<void>((resolve) => {
			watch.start(async (call) => {
				if (call.kind !== "value") {
					return;
				}
				view = projectView(transcript.merge(call.value));
				if (view.running) {
					sawRun = true;
				}
				if (sawRun && !view.running) {
					resolve();
				}
			});
		});
		await watch.stop();
		// Keep the RPC return shallow for serializability checking.
		return JSON.stringify(view);
	}

	/** The view projected from a new watch, as a client joining now sees it. */
	async snapshotView(): Promise<string> {
		const watch = await this.harness.session().watch();
		await watch.stop();
		return JSON.stringify(projectView(this.#transcript().merge(watch.value)));
	}

	/**
	 * Append `count` user-message entries to the root session, `perCommit` to
	 * a commit, with the texts `${prefix} 1` to `${prefix} ${count}`.
	 */
	async appendNotes(prefix: string, count: number, perCommit = count): Promise<void> {
		const root = await (await this.harness.pi()).root(BG);
		for (let start = 1; start <= count; start += perCommit) {
			const end = Math.min(start + perCommit - 1, count);
			await root.commit(async (tx) => {
				for (let n = start; n <= end; n++) {
					await tx.appendEntry(root.id, {
						kind: "test.note",
						model: [{ role: "user", content: `${prefix} ${n}`, timestamp: Date.now() }],
					});
				}
			}, BG);
		}
	}

	/**
	 * Close pi, as a storage error does. The harness opens it again on the
	 * next call, and every watch of the closed pi has ended.
	 */
	async closePi(): Promise<void> {
		await (await this.harness.pi()).close(BG);
	}

	/** Make pi fail to open, or open again. */
	failOpens(fail: boolean): void {
		this.#failOpens = fail;
	}

	/** Compact the root session and wait for the summary to be placed. */
	async compact(): Promise<void> {
		const pi = await this.harness.pi();
		const root = await pi.root(BG);
		const task = await root.compact(undefined, BG);
		const { state } = await pi.waitForTask(task, BG);
		if (state.status !== "terminal" || state.outcome.status !== "completed") {
			throw new Error(`Compaction did not complete: ${JSON.stringify(state)}`);
		}
		const { submissionId } = state.outcome.result;
		if (submissionId === undefined) {
			throw new Error("Nothing was compacted");
		}
		await (await pi.submission(submissionId, BG))?.wait(BG);
	}

	#transcript(): ConversationTranscript {
		const session = this.harness.session();
		return new ConversationTranscript((query, limit) => session.entries(query, limit));
	}

	/** The fixture's tools and preamble, as one pi extension. */
	#testTools(): Extension {
		const storage = this.ctx.storage;
		const gate = (
			name: string,
			replay: "safe" | "unsafe",
		): ToolRegistration<typeof NoParameters> => ({
			name,
			description: "Wait until the test releases it.",
			parameters: NoParameters,
			replay,
			async execute(_args, api, context) {
				const runs = ((await storage.get<number>(GATE_RUNS_KEY)) ?? 0) + 1;
				await storage.put(GATE_RUNS_KEY, runs);
				api.output(`run ${runs}\n`);
				while (!(await storage.get<boolean>(RELEASE_KEY))) {
					context.abortSignal?.throwIfAborted();
					await new Promise((resolve) => {
						setTimeout(resolve, 20);
					});
				}
				return {
					output: [{ type: "text", text: `released after ${runs} runs` }],
				};
			},
		});
		return {
			name: "test-tools",
			sections: [
				{
					key: "preamble",
					render: () => "Use the supplied test tools.",
					tag: false,
				},
			],
			tools: [multiplyTool(), gate("gate", "safe"), gate("gate_unsafe", "unsafe")],
		};
	}
}

const NoParameters = obj({});
const MultiplyParameters = obj({ value: num() });

/** Multiplies by three. */
function multiplyTool(): ToolRegistration<typeof MultiplyParameters> {
	return {
		name: "multiply",
		description: "Multiply by three.",
		parameters: MultiplyParameters,
		replay: "safe",
		async execute({ value }) {
			return {
				output: [{ type: "text", text: String(value * 3) }],
				details: { result: value * 3 },
			};
		},
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (env.EFFECT_HARNESS_AI) {
			return serveEffectHarness(request, env);
		}
		const url = new URL(request.url);
		const { pathname } = url;
		if (pathname === "/__browser-smoke/ready") {
			return new Response("Trajan browser fixture");
		}
		// Give each browser test a fresh main chat while keeping the app URL fixed.
		const fixture = /(?:^|;\s*)trajan-fixture=([a-f0-9-]+)(?:;|$)/.exec(
			request.headers.get("Cookie") ?? "",
		)?.[1];
		if (fixture && pathname.startsWith("/__effect-harness/")) {
			return serveEffectHarness(request, env, fixture);
		}
		const streamControl = /^\/__browser-smoke\/effect-stream\/(pause|release|crash)$/.exec(
			pathname,
		)?.[1];
		if (streamControl && fixture && request.method === "POST") {
			const stub = env.EFFECT_HARNESS_TEST.getByName(fixture);
			switch (streamControl) {
				case "pause":
					await stub.pause("during-reply");
					break;
				case "release":
					await stub.release();
					break;
				case "crash":
					await stub.crash();
					break;
			}
			return new Response(null, { status: 204 });
		}
		if (pathname.startsWith("/agents/trajan/")) {
			if (!isMainChatUrl(url)) {
				return new Response("Not found", { status: 404 });
			}
			if (fixture) {
				url.pathname = `/agents/trajan/${fixture}`;
				request = new Request(url, request);
			}
		}
		const control = /^\/__browser-smoke\/(disconnect|release|crash|codemode-state)$/.exec(
			pathname,
		)?.[1];
		if (control && fixture && request.method === "POST") {
			const stub = env.PI_HARNESS_TEST.getByName(fixture);
			switch (control) {
				case "disconnect":
					await stub.disconnect();
					break;
				case "release":
					await stub.release();
					break;
				case "crash":
					await stub.crash();
					break;
				case "codemode-state":
					return Response.json(await stub.codemodeState());
			}
			return new Response(null, { status: 204 });
		}
		return (
			(await routeAgentRequest(request, { Trajan: env.PI_HARNESS_TEST })) ??
			new Response("Not found", { status: 404 })
		);
	},
};
