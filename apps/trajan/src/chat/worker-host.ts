import { TurnSubmission } from "@trajan/harness";
import type { TurnProgress } from "@trajan/harness";
import { CloudflareHarness } from "@trajan/harness-cloudflare";
import { WebSockets } from "agents/websockets";
import { Schema } from "effect";
import { TurnSchedules } from "../turn-schedules";
import { ChatEvent, ChatHistoryQuery, ChatPath, ChatStop } from "./protocol";
import type { ChatPreview, ChatSnapshot, ChatToolInfo } from "./protocol";
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
	protected readonly schedules = new TurnSchedules((input) => this.submit(input));

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

	protected override clearRunState(runId: string): undefined {
		clearToolState(this.ctx.storage, runId);
	}

	protected override onStateChange(settledRunId?: string) {
		if (settledRunId !== undefined && this.#draft?.runId === settledRunId) {
			this.#draft = undefined;
		}
		this.#broadcastSnapshot();
	}

	protected override onProgress(runId: string, event: TurnProgress) {
		switch (event.type) {
			case "reset":
			case "tool": {
				const tool = event.type === "tool" ? event.name : null;
				this.#draft = { runId, text: "", tool, activity: [] };
				this.#broadcast({ type: "preview", ...this.#draft });
				break;
			}
			case "tool-activity":
				if (this.#draft?.runId === runId && this.#draft.tool !== null) {
					this.#draft = { ...this.#draft, activity: event.activity };
					this.#broadcast({ type: "preview", ...this.#draft });
				}
				break;
			case "text-delta":
				if (this.#draft?.runId === runId) {
					this.#draft = { ...this.#draft, text: this.#draft.text + event.text };
					this.#broadcast({ ...event, runId });
				}
				break;
		}
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

	protected async chatRequest(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === `${ChatPath}/history` && request.method === "GET") {
			const before = url.searchParams.get("before");
			const query = decodeHistory(before === null ? {} : { before: Number(before) });
			if (query._tag === "None") {
				return Response.json({ error: "Invalid history cursor." }, { status: 400 });
			}
			return Response.json(await this.page(query.value));
		}
		if (request.method !== "POST") {
			return new Response(null, { status: 404 });
		}
		const body: unknown = await request.json().catch(() => null);
		switch (url.pathname) {
			case ChatPath: {
				const input = decodeSubmission(body);
				if (input._tag === "None") {
					return Response.json(
						{ accepted: false, runId: null, error: "Invalid submission." },
						{ status: 400 },
					);
				}
				const receipt = await this.submit(input.value);
				return Response.json(
					{ submissionId: input.value.id, ...receipt },
					{ status: receipt.runId === null ? 400 : 202 },
				);
			}
			case `${ChatPath}/stop`: {
				const input = decodeStop(body);
				if (input._tag === "None") {
					return Response.json({ error: "Invalid run ID." }, { status: 400 });
				}
				return Response.json(await this.stop(input.value.runId));
			}
			default:
				return new Response(null, { status: 404 });
		}
	}
}
