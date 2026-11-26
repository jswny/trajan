import { TurnSubmission } from "@trajan/harness";
import type { TurnMessage, TurnProgress } from "@trajan/harness";
import { CloudflareHarness } from "@trajan/harness-cloudflare";
import { WebSockets } from "agents/websockets";
import { Effect, Schema } from "effect";
import { TurnSchedules } from "../turn-schedules";
import {
	ChatEvent,
	ChatHistoryPath,
	ChatHistoryQuery,
	ChatPath,
	ChatStop,
	ChatStopPath,
	updateToolPreview,
} from "./protocol";
import type {
	BrowserWatch,
	ChatPreview,
	ChatSnapshot,
	ChatToolInfo,
	ChatToolPreview,
} from "./protocol";
import { clearToolState } from "./tool-activity";

const chatEventJson = Schema.encodeSync(Schema.fromJsonString(ChatEvent));
const chatTag = "chat";
const decodeSubmission = Schema.decodeUnknownOption(TurnSubmission);
const decodeHistory = Schema.decodeUnknownOption(ChatHistoryQuery);
const decodeStop = Schema.decodeUnknownOption(ChatStop);

function sendChat(socket: WebSocket, data: string) {
	if (socket.readyState === 1) {
		try {
			socket.send(data);
		} catch {
			// A disconnected observer cannot affect the durable turn.
		}
	}
}

export abstract class TrajanChatObject extends CloudflareHarness<Env> {
	protected readonly toolCatalog: ReadonlyArray<typeof ChatToolInfo.Type> = [];
	protected readonly schedules = new TurnSchedules(
		(input) => this.submitEffect(input),
		(input, text) => this.recordUnadmittedSubmission(input, text),
	);
	protected get browserWatch(): typeof BrowserWatch.Type {
		return null;
	}

	protected publishBrowserAvailability() {
		this.#broadcast({ type: "browser", browserWatch: this.browserWatch });
	}

	#draft: typeof ChatPreview.Type | undefined;
	readonly #sockets = new WebSockets({
		protocol: false,
		getConnectionTags: () => [chatTag],
		handlers: {
			onConnect: (socket) => sendChat(socket, chatEventJson(this.#snapshot())),
		},
	});

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.#sockets).use(this.schedules);
	}

	protected abstract readSettledTools(runId: string): ReadonlyArray<typeof TurnMessage.Type>;

	protected override settleRunState(runId: string, outcome: "completed" | "failed" | "cancelled") {
		const tools = outcome === "completed" ? undefined : this.readSettledTools(runId);
		clearToolState(this.ctx.storage, runId);
		return tools;
	}

	protected override onStateChange(settledRunId?: string) {
		if (settledRunId !== undefined && this.#draft?.runId === settledRunId) {
			this.#draft = undefined;
		}
		this.#broadcastSnapshot();
	}

	protected override onProgress(runId: string, event: TurnProgress) {
		const draft = this.#draft?.runId === runId ? this.#draft : { runId, text: "", tools: [] };
		switch (event.type) {
			case "reset": {
				this.#draft = { ...draft, text: "" };
				this.#broadcast({ type: "reset", runId });
				break;
			}
			case "tool":
				this.#publishTool(draft, { call: event.call, activity: [] });
				break;
			case "tool-activity": {
				const tool = draft.tools.find(({ call }) => call.id === event.callId);
				if (tool && !tool.result) {
					this.#publishTool(draft, { ...tool, activity: event.activity });
				}
				break;
			}
			case "tool-result":
				this.#publishTool(draft, { call: event.call, activity: [], result: event.result });
				break;
			case "text-delta":
				this.#draft = { ...draft, text: draft.text + event.text };
				this.#broadcast({ ...event, runId });
				break;
		}
	}

	#publishTool(draft: typeof ChatPreview.Type, tool: typeof ChatToolPreview.Type) {
		this.#draft = updateToolPreview(draft, tool);
		this.#broadcast({ type: "tool", runId: draft.runId, tool });
	}

	#snapshot(): typeof ChatSnapshot.Type {
		const { page, active, queued } = this.snapshot();
		const draft = this.#draft;
		return {
			type: "snapshot",
			page,
			active,
			queued,
			preview: draft && draft.runId === active?.runId ? draft : null,
			catalog: this.toolCatalog,
			browserWatch: this.browserWatch,
		};
	}

	#broadcast(event: typeof ChatEvent.Type) {
		const sockets = this.ctx.getWebSockets(chatTag);
		if (sockets.length > 0) {
			const data = chatEventJson(event);
			for (const socket of sockets) {
				sendChat(socket, data);
			}
		}
	}

	#broadcastSnapshot() {
		if (this.ctx.getWebSockets(chatTag).length > 0) {
			this.#broadcast(this.#snapshot());
		}
	}

	protected readonly chatRequest = Effect.fn("chat.request")(function* (
		this: TrajanChatObject,
		request: Request,
	) {
		const url = new URL(request.url);
		if (url.pathname === ChatHistoryPath && request.method === "GET") {
			const before = url.searchParams.get("before");
			const query = decodeHistory(before === null ? {} : { before: Number(before) });
			if (query._tag === "None") {
				return Response.json({ error: "Invalid history cursor." }, { status: 400 });
			}
			return Response.json(yield* this.readPage(query.value));
		}
		if (request.method !== "POST") {
			return new Response(null, { status: 404 });
		}
		const body: unknown = yield* Effect.tryPromise(() => request.json()).pipe(
			Effect.orElseSucceed(() => null),
		);
		switch (url.pathname) {
			case ChatPath: {
				const input = decodeSubmission(body);
				if (input._tag === "None") {
					return Response.json(
						{ accepted: false, runId: null, error: "Invalid submission." },
						{ status: 400 },
					);
				}
				const receipt = yield* this.submitEffect(input.value);
				return Response.json(
					{ submissionId: input.value.id, ...receipt },
					{ status: receipt.runId === null ? 400 : 202 },
				);
			}
			case ChatStopPath: {
				const input = decodeStop(body);
				if (input._tag === "None") {
					return Response.json({ error: "Invalid run ID." }, { status: 400 });
				}
				return Response.json(yield* this.stopEffect(input.value.runId));
			}
			default:
				return new Response(null, { status: 404 });
		}
	});
}
