import { TurnModel, TurnTools } from "@trajan/effect-harness";
import { Data, Effect, Layer } from "effect";
import { ChatPath, isEffectChatPath } from "./effect-harness/chat-protocol";
import { EffectHarnessObject } from "./effect-harness/worker-host";
import { workersAiTurnModel } from "./effect-harness/workers-ai";
import { effectWorkspaceTools } from "./effect-harness/workspace-tools";
import { createTrajanWorkspace, WORKSPACE_PROMPT } from "./workspace";

class ChatRouteError extends Data.TaggedError("ChatRouteError")<{ readonly cause: unknown }> {}

export class Trajan extends EffectHarnessObject {
	readonly #computer = createTrajanWorkspace(this.ctx.storage, this.env.LOADER);
	readonly #tools = effectWorkspaceTools(this.#computer.workspace, this.#computer.instructions);

	protected override readonly toolCatalog = [
		{
			name: this.#tools.declaration.name,
			description: this.#tools.declaration.description,
		},
	];
	protected readonly turnLayer = Layer.merge(
		Layer.succeed(
			TurnModel,
			workersAiTurnModel(this.env.AI, this.#tools.declaration, WORKSPACE_PROMPT),
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
		if (!isEffectChatPath(url.pathname)) {
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
				try: () => env.Trajan.getByName("effect-main").fetch(request),
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
