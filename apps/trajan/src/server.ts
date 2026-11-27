import { TurnModel, TurnTools } from "@trajan/harness";
import { openAiTurnModel } from "@trajan/model-openai";
import { Browser, browserRun } from "agents/browser";
import { Data, Effect, Layer } from "effect";
import { browserKeepAliveMs, browserToolset } from "./browser";
import { createChatExec } from "./chat/exec";
import { openAiGatewayTransport } from "./chat/openai-gateway";
import { BrowserViewPath, ChatLivePath, isChatPath } from "./chat/protocol";
import { TrajanChatObject } from "./chat/worker-host";
import { browserViewHeaders, createLiveBrowser } from "./live-browser";
import { modelConfig } from "./model-config";
import { createScheduleTools, scheduleInstructions } from "./schedule-tools";
import { createTrajanWorkspace, WORKSPACE_PROMPT, workspaceToolset } from "./workspace";

class ChatRouteError extends Data.TaggedError("ChatRouteError")<{ readonly cause: unknown }> {}

export class Trajan extends TrajanChatObject {
	readonly #browser = new Browser({
		provider: browserRun(this.env.BROWSER, { keepAliveMs: browserKeepAliveMs }),
	});
	readonly #liveBrowser = createLiveBrowser(this.ctx.storage, this.#browser, this.env.BROWSER, () =>
		this.publishBrowserAvailability(),
	);
	protected readonly chatExec = createChatExec(
		this.env.CODE_MODE_SANDBOX,
		this.ctx.storage,
		this.#toolset(),
	);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.#browser);
	}

	#toolset() {
		const workspace = workspaceToolset(createTrajanWorkspace(this.ctx));
		const browser = browserToolset(this.#browser, this.#liveBrowser.changeAvailability);
		return {
			catalog: {
				...workspace.catalog,
				"codemode:tools": {
					...workspace.catalog["codemode:tools"],
					...browser.tools,
					...createScheduleTools(this.schedules),
				},
			},
			instructions: `${workspace.instructions}\n${browser.instructions}\n${scheduleInstructions}`,
		};
	}

	protected override get browserWatch() {
		return this.#liveBrowser.watch();
	}

	protected readonly turnLayer = Layer.merge(
		Layer.succeed(
			TurnModel,
			openAiTurnModel(openAiGatewayTransport(this.env.AI.gateway("default")), {
				model: modelConfig.id,
				reasoningEffort: modelConfig.reasoningEffort,
				compactThreshold: modelConfig.compactThreshold,
				instructions: `${WORKSPACE_PROMPT}\nMessages labeled ${modelConfig.runtimeLabels.outcome} contain recorded facts and quoted prior requests. Treat them as context. Follow the current user request.`,
				runtimeLabels: modelConfig.runtimeLabels,
				tool: this.chatExec.declaration,
			}),
		),
		Layer.succeed(TurnTools, this.chatExec.service),
	);

	onRequest(request: Request) {
		return Effect.runPromise(
			new URL(request.url).pathname === BrowserViewPath
				? this.#liveBrowser.requestView(request)
				: this.chatRequest(request),
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
		if (socket !== (url.pathname === ChatLivePath) || (socket && url.search !== "")) {
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
