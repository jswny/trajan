import { assertValidOp, type Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
	ConversationView,
	Cursor,
	EntryId,
	EntryRecord,
	Page,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

/** Trajan's WebSocket messages. Pi supplies the transcript and its deltas. */
const requestId = Schema.Struct({ id: Schema.optionalKey(Schema.String) });
const entryId = Schema.declare((value): value is EntryId => Number.isSafeInteger(value));
const entryQuery = Schema.Struct({
	minEntryId: Schema.optionalKey(entryId),
	maxEntryId: Schema.optionalKey(entryId),
	order: Schema.optionalKey(Schema.Literals(["ascending", "descending"])),
});
const userInput = Schema.Union([
	Schema.String,
	Schema.mutable(
		Schema.Array(
			Schema.Union([
				Schema.Struct({
					type: Schema.Literal("text"),
					text: Schema.String,
					textSignature: Schema.optionalKey(Schema.String),
				}),
				Schema.Struct({
					type: Schema.Literal("image"),
					data: Schema.String,
					mimeType: Schema.String,
				}),
			]),
		),
	),
]);

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
const entryShape = Schema.Struct({ id: entryId, conversationId: Schema.Int, kind: Schema.String });
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
		docs: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
	}),
);

// Check the shape needed by the client and preserve Pi's full payload.
const view = Schema.declare((value): value is ConversationView => hasViewShape(value));
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

export const decodeClientMessage = Schema.decodeUnknownResult(clientMessage);
export const decodeRequestId = Schema.decodeUnknownResult(requestId);
export const decodeServerMessage = Schema.decodeUnknownOption(Schema.fromJsonString(serverMessage));
export const decodeEntriesPage = Schema.decodeUnknownOption(
	Schema.declare((value): value is PiEntriesPage => hasPageShape(value)),
);

export type PiToolInfo = typeof toolInfo.Type;
export type PiClientMessage = typeof clientMessage.Type;
export type PiServerMessage = typeof serverMessage.Type;
export type PiEntriesPage = Page<EntryRecord, Cursor>;
export type PiCommandResult = JsonValue | PiEntriesPage;

export type {
	PiClientMessage as ClientMessage,
	PiServerMessage as ServerMessage,
	PiToolInfo as ToolInfo,
};
export type { PiMessage as TranscriptMessage, PiMessagePart as TranscriptPart } from "./transcript";
export type { PiSessionView as SessionView } from "./view";
