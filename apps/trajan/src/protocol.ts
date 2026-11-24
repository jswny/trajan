import { assertValidOp } from "@earendil-works/chord/delta";
import type { Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
	ConversationView,
	Cursor,
	EntryId,
	EntryRecord,
	Page,
} from "@earendil-works/pi-durable";
import type { PiReceipt } from "agents/harness/pi";
import { Schema } from "effect";

/** Trajan's WebSocket messages. Pi supplies the transcript and its deltas. */
const requestId = Schema.Struct({ id: Schema.optionalKey(Schema.String) });
const entryId = Schema.declare((value): value is EntryId => Number.isSafeInteger(value));
const entryQuery = Schema.Struct({
	minEntryId: Schema.optionalKey(entryId),
	maxEntryId: Schema.optionalKey(entryId),
	order: Schema.optionalKey(Schema.Literals(["ascending", "descending"])),
});
const textContent = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
	textSignature: Schema.optionalKey(Schema.String),
});
const imageContent = Schema.Struct({
	type: Schema.Literal("image"),
	data: Schema.String,
	mimeType: Schema.String,
});
const textOrImageContent = Schema.Array(Schema.Union([textContent, imageContent]));
const userInput = Schema.Union([Schema.String, Schema.mutable(textOrImageContent)]);

const clientMessage = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("submit"),
		...requestId.fields,
		input: userInput,
		whenBusy: Schema.optionalKey(Schema.Literals(["followUp", "steer", "reject"])),
		operationId: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({ type: Schema.Literal("abort"), ...requestId.fields }),
	Schema.Struct({
		type: Schema.Literal("reset"),
		...requestId.fields,
		handoff: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("watch"),
		...requestId.fields,
		from: Schema.optionalKey(entryId),
	}),
	Schema.Struct({
		type: Schema.Literal("entries"),
		id: Schema.String,
		query: Schema.optionalKey(Schema.NullOr(entryQuery)),
		limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	}),
]);

const toolInfo = Schema.Struct({ name: Schema.String, description: Schema.String });
const assistantMessage = Schema.Struct({
	role: Schema.Literal("assistant"),
	timestamp: Schema.Finite,
	stopReason: Schema.String,
	errorMessage: Schema.optionalKey(Schema.String),
	content: Schema.Array(
		Schema.Union([
			textContent,
			Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
			Schema.Struct({
				type: Schema.Literal("toolCall"),
				id: Schema.String,
				name: Schema.String,
				arguments: Schema.Json,
			}),
		]),
	),
});
const transcriptMessage = Schema.Union([
	Schema.Struct({ role: Schema.Literal("system"), timestamp: Schema.Finite }),
	Schema.Struct({
		role: Schema.Literal("user"),
		timestamp: Schema.Finite,
		content: userInput,
	}),
	assistantMessage,
	Schema.Struct({
		role: Schema.Literal("toolResult"),
		timestamp: Schema.Finite,
		toolCallId: Schema.String,
		toolName: Schema.String,
		content: textOrImageContent,
		isError: Schema.Boolean,
		details: Schema.optionalKey(Schema.Json),
	}),
]);
const entryShape = Schema.Struct({
	id: entryId,
	conversationId: Schema.Int,
	kind: Schema.String,
	// Trajan projects the first message contributed by an entry.
	model: Schema.optionalKey(
		Schema.Union([
			Schema.Tuple([]),
			Schema.TupleWithRest(Schema.Tuple([transcriptMessage]), [Schema.Unknown]),
		]),
	),
});
const document = Schema.Record(Schema.String, Schema.Unknown);
const transcriptDocs = Schema.Struct({
	"pi.live": Schema.optionalKey(
		Schema.Struct({
			run: Schema.optionalKey(document),
			generation: Schema.optionalKey(
				Schema.Struct({
					message: Schema.optionalKey(assistantMessage),
					retry: Schema.optionalKey(Schema.Struct({ at: Schema.Finite, error: Schema.String })),
				}),
			),
			tools: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						callId: Schema.String,
						name: Schema.String,
						status: Schema.String,
						output: Schema.optionalKey(Schema.String),
					}),
				),
			),
			runFailure: Schema.optionalKey(
				Schema.Struct({
					reason: Schema.String,
					detail: Schema.optionalKey(Schema.String),
				}),
			),
		}),
	),
	"pi.inbox": Schema.optionalKey(Schema.Struct({ items: Schema.Array(Schema.Unknown) })),
	"pi.agent": Schema.optionalKey(
		Schema.Struct({
			model: Schema.optionalKey(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
		}),
	),
});
const conversationDocs = Schema.StructWithRest(transcriptDocs, [
	Schema.Record(Schema.String, document),
]);
const hasPageShape = Schema.is(
	Schema.Struct({
		items: Schema.Array(entryShape),
		next: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	}),
);
const hasViewShape = Schema.is(
	Schema.Struct({
		conversation: Schema.Struct({ id: Schema.Int }),
		entries: Schema.Array(entryShape),
		before: Schema.optionalKey(entryId),
		docs: conversationDocs,
	}),
);

// Check the shape needed by the client and preserve Pi's full payload.
export function isConversationView(value: unknown): value is ConversationView {
	return hasViewShape(value);
}
const view = Schema.declare(isConversationView);
const op = Schema.declare((value): value is Op => {
	try {
		assertValidOp(value);
		return true;
	} catch {
		return false;
	}
});

const serverMessage = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("hello"),
		session: Schema.String,
		tools: Schema.Array(toolInfo),
	}),
	Schema.Struct({ type: Schema.Literal("view"), session: Schema.String, view }),
	Schema.Struct({ type: Schema.Literal("ops"), session: Schema.String, ops: Schema.Array(op) }),
	Schema.Struct({ type: Schema.Literal("result"), id: Schema.String, result: Schema.Unknown }),
	Schema.Struct({ type: Schema.Literal("error"), ...requestId.fields, message: Schema.String }),
]);

export const decodeEntryId = Schema.decodeUnknownSync(entryId);
export const decodeClientMessage = Schema.decodeUnknownResult(clientMessage);
export const decodeRequestId = Schema.decodeUnknownResult(requestId);
export const decodeServerMessage = Schema.decodeUnknownOption(Schema.fromJsonString(serverMessage));
export const isSubmitReceipt = Schema.is(
	Schema.Struct({
		operationId: Schema.NonEmptyString,
		session: Schema.NonEmptyString,
		accepted: Schema.Boolean,
	}) satisfies Schema.Schema<PiReceipt>,
);
export const decodeEntriesPage = Schema.decodeUnknownOption(
	Schema.declare((value): value is PiEntriesPage => hasPageShape(value)),
);

export type PiToolInfo = typeof toolInfo.Type;
export type PiClientMessage = typeof clientMessage.Type;
export type PiServerMessage = typeof serverMessage.Type;
export type PiEntriesPage = Page<EntryRecord, Cursor>;
export type PiCommandResult = JsonValue | PiEntriesPage;
export type TranscriptDocs = typeof transcriptDocs.Type;
export type TranscriptModelMessage = typeof transcriptMessage.Type;

export type {
	PiClientMessage as ClientMessage,
	PiServerMessage as ServerMessage,
	PiToolInfo as ToolInfo,
};
export type { PiMessage as TranscriptMessage, PiMessagePart as TranscriptPart } from "./transcript";
export type { PiSessionView as SessionView } from "./view";
