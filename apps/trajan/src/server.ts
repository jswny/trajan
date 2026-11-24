import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { CodemodeBackend } from "@cloudflare/computer/backends/codemode";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { routeAgentRequest } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { WebSockets } from "agents/websockets";
import { Data, Effect } from "effect";
import { workspaceCodemode } from "./codemode";
import { isMainChatUrl } from "./main-chat";
import { MODEL_ID } from "./model-id";
import { PiSessionSockets } from "./sockets";
import { createWorkspaceTools, WORKSPACE_PROMPT } from "./workspace";

class AgentRouteError extends Data.TaggedError("AgentRouteError")<{
	readonly cause: unknown;
	readonly message: string;
}> {}

/** Playable pi session backed by one Durable Object. */
export class Trajan extends DurableObject<Env> {
	// Workers AI and AI Gateway over the AI binding, as a pi-ai provider.
	readonly ai = createAI({ binding: this.env.AI });
	readonly model = this.ai(MODEL_ID);
	// A durable filesystem on the object's SQLite, beside pi's own tables.
	// `exec` runs JavaScript modules in a fresh Dynamic Worker per call, with
	// no network of its own. `git` turns on `workspace.git`, which the `codemode:git`
	// module calls in the host; `allowNetwork` lets it clone, fetch and push.
	readonly workspace = new Workspace({
		storage: this.ctx.storage,
		git: createGitClient(),
		backends: [
			new CodemodeBackend({
				loader: this.env.LOADER,
				root: "/workspace",
				access: "read-write",
				modules: { "codemode:git": createGitModule({ allowNetwork: true }) },
			}),
		],
	});
	readonly registry = createRegistry();
	readonly harness = new PiHarness({
		harness: ({ storage, context, onWake }) => {
			this.registry.install({
				name: "playground",
				sections: [{ key: "preamble", render: () => WORKSPACE_PROMPT, tag: false }],
				tools: createWorkspaceTools(this.workspace),
			});
			this.registry.install(
				workspaceCodemode(() => this.env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString())),
			);
			const models = createModels();
			models.setProvider(this.ai.provider);
			return Harness.open(
				storage,
				{
					models,
					registry: this.registry,
					onWake,
					settings: {
						// Pi doubles the delay before each retry, for about 30 seconds total.
						retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 },
					},
					onReport: (report) => Effect.runSync(Effect.logWarning({ event: "pi_report", report })),
				},
				context,
			);
		},
		defaults: { model: this.model, thinkingLevel: "low" },
	});

	// App glue, not the harness: how this app puts sessions on a socket.
	readonly sockets = new PiSessionSockets(this.harness, this.registry, (tag) =>
		this.ctx.getWebSockets(tag),
	);
	readonly webSockets = new WebSockets(this.sockets.options());
	readonly lifecycle = Lifecycle.install(this).use(this.webSockets).use(this.harness);

	/** Host startup, after the harness has opened pi. */
	onStart(): Promise<void> {
		return this.sockets.reattach();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") {
			return Response.json({ ok: true, service: "trajan" });
		}
		if (!isMainChatUrl(url)) {
			return new Response("Not found", { status: 404 });
		}
		const origin = request.headers.get("Origin");
		if (origin !== null && origin !== url.origin) {
			return new Response("Forbidden", { status: 403 });
		}
		return Effect.runPromise(
			Effect.tryPromise({
				try: () => routeAgentRequest(request, env),
				catch: (cause) =>
					new AgentRouteError({
						cause,
						message: cause instanceof Error ? cause.message : String(cause),
					}),
			}).pipe(
				Effect.map((response) => response ?? new Response("Not found", { status: 404 })),
				Effect.catchTag("AgentRouteError", ({ message }) =>
					Effect.gen(function* () {
						yield* Effect.logError({ event: "request_failed", error: message });
						return Response.json({ error: message }, { status: 500 });
					}),
				),
			),
		);
	},
} satisfies ExportedHandler<Env>;
