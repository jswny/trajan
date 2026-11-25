import { TurnModel, TurnTools } from "@trajan/harness";
import { openAiTurnModel } from "@trajan/model-openai";
import { Browser, browserRun } from "agents/browser";
import { Data, Effect, Layer } from "effect";
import { browserToolset } from "./browser";
import { openAiGatewayTransport } from "./chat/openai-gateway";
import { ChatPath, isChatPath } from "./chat/protocol";
import { TrajanChatObject } from "./chat/worker-host";
import { createChatTools } from "./chat/tools";
import { modelConfig } from "./model-config";
import { createTrajanWorkspace, WORKSPACE_PROMPT, workspaceToolset } from "./workspace";

class ChatRouteError extends Data.TaggedError("ChatRouteError")<{ readonly cause: unknown }> {}

export class Trajan extends TrajanChatObject {
	readonly #browser = new Browser({
		provider: browserRun(this.env.BROWSER, { keepAliveMs: 120_000 }),
	});
	readonly #tools = createChatTools(
		this.env.LOADER,
		this.ctx.storage,
		this.schedules,
		this.#toolset(),
	);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.#browser);
	}

	#toolset() {
		const workspace = workspaceToolset(createTrajanWorkspace(this.ctx));
		const browser = browserToolset(this.#browser);
		return {
			catalog: {
				...workspace.catalog,
				"codemode:tools": { ...workspace.catalog["codemode:tools"], ...browser.tools },
			},
			instructions: `${workspace.instructions}\n${browser.instructions}`,
		};
	}

	protected override readonly toolCatalog = [
		{
			name: this.#tools.declaration.name,
			description: this.#tools.declaration.description,
		},
	];
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
		return this.chatRequest(request);
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
