import { TurnSubmission } from "@trajan/harness";
import type { TurnIoError, TurnProgress } from "@trajan/harness";
import { CloudflareHarness } from "@trajan/harness-cloudflare";
import { WebSockets } from "agents/websockets";
import { Effect, Schema } from "effect";
import { TurnSchedules } from "../turn-schedules";
import type { createChatExec } from "./exec";
import { updateToolPreview } from "./preview";
import {
	ChatEvent,
	ChatHistoryPath,
	ChatHistoryQuery,
	ChatPath,
	ChatStop,
	ChatStopPath,
} from "./protocol";
import type { BrowserWatch, ChatPreview, ChatSnapshot, ChatToolPreview } from "./protocol";
import { describeRecoveredTool, RECENT_TOOL_CALLS } from "./tool-activity";

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
	#liveModelRunId: string | undefined;
	readonly #joining = new WeakSet<WebSocket>();
	readonly #sockets = new WebSockets({
		protocol: false,
		getConnectionTags: () => [chatTag],
		handlers: {
			onConnect: (socket) => {
				this.#joining.add(socket);
				return Effect.runPromise(
					this.#snapshot().pipe(
						Effect.map((snapshot) => sendChat(socket, chatEventJson(snapshot))),
						Effect.ensuring(
							Effect.sync(() => {
								this.#joining.delete(socket);
							}),
						),
					),
				);
			},
		},
	});

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.lifecycle.use(this.#sockets).use(this.schedules);
	}

	protected abstract readonly chatExec: Pick<
		ReturnType<typeof createChatExec>,
		"readToolPreviews" | "settleRun"
	>;
	protected override describeRecoveredTool = describeRecoveredTool;

	protected override settleRunState(runId: string, outcome: "completed" | "failed" | "cancelled") {
		return this.chatExec.settleRun(runId, outcome);
	}

	protected override onStateChange({
		settledRunId,
		historyChanged,
	}: {
		readonly settledRunId?: string;
		readonly historyChanged: boolean;
	}) {
		if (settledRunId !== undefined && this.#draft?.runId === settledRunId) {
			this.#draft = undefined;
			this.#liveModelRunId = undefined;
		}
		if (historyChanged) {
			return this.#broadcastSnapshot();
		} else if (this.ctx.getWebSockets(chatTag).length > 0) {
			this.#broadcast({ type: "run-state", ...this.runState() });
		}
	}

	protected override onProgress(runId: string, event: TurnProgress) {
		const draft = this.#draft?.runId === runId ? this.#draft : this.#savedPreview(runId);
		switch (event.type) {
			case "reset": {
				const interrupted = this.readInterruptedDrafts(runId);
				this.#draft = { ...draft, text: "", interrupted };
				this.#liveModelRunId = runId;
				this.#broadcast({ type: "reset", runId, interrupted });
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
			case "tool-result": {
				const { result } = event;
				const activity = result.activity?.slice(-RECENT_TOOL_CALLS);
				this.#publishTool(draft, {
					call: event.call,
					activity: [],
					result: { ...result, ...(activity && { activity }) },
				});
				break;
			}
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

	#savedPreview(runId: string): typeof ChatPreview.Type {
		return {
			runId,
			text: "",
			interrupted: this.readInterruptedDrafts(runId),
			tools: this.chatExec.readToolPreviews(runId),
		};
	}

	readonly #snapshot = Effect.fnUntraced(function* (
		this: TrajanChatObject,
	): Effect.fn.Return<typeof ChatSnapshot.Type, TurnIoError> {
		while (true) {
			const readingRun = this.runState().active?.runId;
			const saved =
				readingRun && this.#liveModelRunId !== readingRun
					? yield* this.readModelDraft(readingRun)
					: undefined;
			const { page, active, queued } = this.snapshot();
			const runId = active?.runId;
			const live = this.#draft?.runId === runId ? this.#draft : undefined;
			// The turn can change while the SDK reads its durable chunks.
			if (runId && runId !== readingRun && this.#liveModelRunId !== runId) {
				continue;
			}
			const draft = runId && {
				...(live ?? this.#savedPreview(runId)),
				// Replayed tool progress can exist before this isolate starts a model attempt.
				...(this.#liveModelRunId !== runId && saved),
			};
			return {
				type: "snapshot",
				page,
				active,
				queued,
				preview:
					draft && (draft.text || draft.tools.length || draft.interrupted.length) ? draft : null,
				browserWatch: this.browserWatch,
			};
		}
	});

	#broadcast(event: typeof ChatEvent.Type) {
		const sockets = this.ctx.getWebSockets(chatTag);
		if (sockets.length > 0) {
			const data = chatEventJson(event);
			for (const socket of sockets) {
				if (!this.#joining.has(socket)) {
					sendChat(socket, data);
				}
			}
		}
	}

	#broadcastSnapshot() {
		if (this.ctx.getWebSockets(chatTag).length > 0) {
			return Effect.runPromise(
				this.#snapshot().pipe(Effect.map((snapshot) => this.#broadcast(snapshot))),
			);
		}
	}

	protected readonly chatRequest = Effect.fn("chat.request")(function* (
		this: TrajanChatObject,
		request: Request,
	) {
		const url = new URL(request.url);
		if (url.pathname === ChatHistoryPath && request.method === "GET") {
			const before = url.searchParams.get("before");
			const limit = url.searchParams.get("limit");
			const query = decodeHistory({
				...(before !== null && { before: Number(before) }),
				...(limit !== null && { limit: Number(limit) }),
			});
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
