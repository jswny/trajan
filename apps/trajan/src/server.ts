import { TurnModel, TurnTools } from "@trajan/harness";
import { openAiTurnModel } from "@trajan/model-openai";
import { Browser, browserRun } from "agents/browser";
import { Clock, Data, Effect, Layer, Option, Schema } from "effect";
import { browserKeepAliveMs, browserToolset } from "./browser";
import { openAiGatewayTransport } from "./chat/openai-gateway";
import {
	BrowserViewPath,
	BrowserViewRequest,
	BrowserViewResponse,
	BrowserWatch,
	ChatPath,
	isChatPath,
} from "./chat/protocol";
import { TrajanChatObject } from "./chat/worker-host";
import { createChatTools } from "./chat/tools";
import { modelConfig } from "./model-config";
import {
	codeModeError,
	createTrajanWorkspace,
	WORKSPACE_PROMPT,
	workspaceToolset,
} from "./workspace";

class ChatRouteError extends Data.TaggedError("ChatRouteError")<{ readonly cause: unknown }> {}
const decodeBrowserView = Schema.decodeUnknownEffect(BrowserViewResponse);
const decodeBrowserViewRequest = Schema.decodeUnknownOption(
	Schema.fromJsonString(BrowserViewRequest),
);
const browserViewHeaders = { "Cache-Control": "no-store" };
const browserWatchKey = "trajan:browser-watch";
const decodeBrowserWatch = Schema.decodeUnknownOption(BrowserWatch);

export class Trajan extends TrajanChatObject {
	readonly #browser = new Browser({
		provider: browserRun(this.env.BROWSER, { keepAliveMs: browserKeepAliveMs }),
	});
	readonly #tools = createChatTools(
		this.env.LOADER,
		this.ctx.storage,
		this.schedules.tools,
		this.#toolset(),
	);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.#browser);
	}

	#toolset() {
		const workspace = workspaceToolset(createTrajanWorkspace(this.ctx));
		const browser = browserToolset(this.#browser, (status) =>
			this.#changeBrowserAvailability(status),
		);
		return {
			catalog: {
				...workspace.catalog,
				"codemode:tools": { ...workspace.catalog["codemode:tools"], ...browser.tools },
			},
			instructions: `${workspace.instructions}\n${browser.instructions}`,
		};
	}

	protected override get browserWatch() {
		return Option.getOrNull(decodeBrowserWatch(this.ctx.storage.kv.get(browserWatchKey)));
	}

	#changeBrowserAvailability(status: "open" | "reopened" | "closed") {
		return Effect.gen({ self: this }, function* () {
			const now = yield* Clock.currentTimeMillis;
			const previous = this.browserWatch;
			const watch =
				status === "closed"
					? null
					: {
							id:
								status === "open" && previous && previous.expiresAt > now
									? previous.id
									: yield* Effect.sync(() => crypto.randomUUID()),
							expiresAt: now + browserKeepAliveMs,
						};
			yield* Effect.try({
				try: () => {
					if (watch === null) {
						this.ctx.storage.kv.delete(browserWatchKey);
					} else {
						this.ctx.storage.kv.put(browserWatchKey, watch);
					}
					this.publishBrowserAvailability();
				},
				catch: codeModeError,
			});
		});
	}

	protected override readSettledTools(runId: string) {
		return this.#tools.readSettledTools(runId);
	}

	protected readonly turnLayer = Layer.merge(
		Layer.succeed(
			TurnModel,
			openAiTurnModel(openAiGatewayTransport(this.env.AI.gateway("default")), {
				model: modelConfig.id,
				reasoningEffort: modelConfig.reasoningEffort,
				compactThreshold: modelConfig.compactThreshold,
				instructions: WORKSPACE_PROMPT,
				tool: this.#tools.declaration,
			}),
		),
		Layer.succeed(TurnTools, this.#tools.service),
	);

	onRequest(request: Request) {
		return Effect.runPromise(
			new URL(request.url).pathname === BrowserViewPath
				? this.#browserView(request)
				: this.chatRequest(request),
		);
	}

	#browserView(request: Request) {
		return Effect.gen({ self: this }, function* () {
			const input = decodeBrowserViewRequest(yield* Effect.tryPromise(() => request.text()));
			if (input._tag === "None") {
				return new Response(null, { status: 400, headers: browserViewHeaders });
			}
			const watch = this.browserWatch;
			if (watch?.id !== input.value.id) {
				return Response.json({ status: "closed" }, { headers: browserViewHeaders });
			}
			const view = yield* Effect.tryPromise(() => this.#browser.liveView({ mode: "tab" }));
			const target = view?.targets.find(
				(tab) => tab.type === "page" && tab.pageUrl?.startsWith("https:"),
			);
			if (!view || !target) {
				if (
					this.browserWatch?.id === watch?.id &&
					this.browserWatch?.expiresAt === watch?.expiresAt
				) {
					yield* this.#changeBrowserAvailability("closed");
				}
				return Response.json({ status: "closed" }, { headers: browserViewHeaders });
			}
			const link = yield* Effect.tryPromise(() =>
				this.env.BROWSER.getLiveView(view.sessionId, {
					targetId: target.targetId,
					mode: "tab",
					expiresInMs: 60_000,
					guardrails: { mode: "readonly" },
				}),
			);
			if (link.options.guardrails?.mode !== "readonly") {
				return new Response(null, { status: 502, headers: browserViewHeaders });
			}
			if (this.browserWatch?.id !== watch.id) {
				return Response.json({ status: "closed" }, { headers: browserViewHeaders });
			}
			const payload = yield* decodeBrowserView({ status: "open", url: link.devtoolsFrontendUrl });
			return Response.json(payload, { headers: browserViewHeaders });
		}).pipe(
			Effect.timeout("8 seconds"),
			Effect.orElseSucceed(() => new Response(null, { status: 502, headers: browserViewHeaders })),
		);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") {
			return Response.json({ ok: true, service: "trajan" });
		}
		if (!isChatPath(url.pathname)) {
			return new Response("Not found", { status: 404 });
		}
		const origin = request.headers.get("Origin");
		if (origin !== null && origin !== url.origin) {
			return new Response("Forbidden", { status: 403 });
		}
		if (
			url.pathname === BrowserViewPath &&
			(request.method !== "POST" || url.search !== "" || origin !== url.origin)
		) {
			return new Response(null, { status: 403, headers: browserViewHeaders });
		}
		const socket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
		if (socket !== (url.pathname === `${ChatPath}/live`) || (socket && url.search !== "")) {
			return new Response("Not found", { status: 404 });
		}
		return Effect.runPromise(
			Effect.tryPromise({
				try: () => env.Trajan.getByName("main").fetch(request),
				catch: (cause) => new ChatRouteError({ cause }),
			}).pipe(
				Effect.catch((error) =>
					Effect.logError(error).pipe(
						Effect.as(Response.json({ error: "Chat request failed." }, { status: 500 })),
					),
				),
			),
		);
	},
} satisfies ExportedHandler<Env>;
