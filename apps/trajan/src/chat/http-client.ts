import { TurnSubmission } from "@trajan/harness";
import { Context, Effect, Layer, Schema } from "effect";
import type { Duration, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
	BrowserViewPath,
	BrowserViewRequest,
	BrowserViewResponse,
	ChatHistoryPath,
	ChatHistoryQuery,
	ChatPage,
	ChatPath,
	ChatReceipt,
	ChatRejectedReceipt,
	ChatStop,
	ChatStopPath,
	ChatStopReceipt,
} from "./protocol";

export class ChatRequestError extends Schema.TaggedError<
	ChatRequestError,
	{ readonly brand: unique symbol }
>()("ChatRequestError", {
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

const decodeOk =
	<S extends Schema.Constraint>(schema: S) =>
	(response: HttpClientResponse.HttpClientResponse) =>
		HttpClientResponse.filterStatusOk(response).pipe(
			Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
		);
const submitReceipt = decodeOk(ChatReceipt);
const rejectedReceipt = HttpClientResponse.schemaBodyJson(ChatRejectedReceipt);
const stopReceipt = decodeOk(ChatStopReceipt);
const historyPage = decodeOk(ChatPage);
const browserView = decodeOk(BrowserViewResponse);

function complete<A, E>(
	request: Effect.Effect<A, E, Scope.Scope>,
	timeout: Duration.Input = "5 seconds",
) {
	return request.pipe(
		Effect.timeout(timeout),
		Effect.scoped,
		Effect.mapError(
			(cause) => new ChatRequestError({ message: "Trajan did not answer the request.", cause }),
		),
	);
}

export class ChatHttp extends Context.Service<
	ChatHttp,
	{
		readonly submit: (
			input: typeof TurnSubmission.Type,
		) => Effect.Effect<typeof ChatReceipt.Type, ChatRequestError>;
		readonly stop: (
			input: typeof ChatStop.Type,
		) => Effect.Effect<typeof ChatStopReceipt.Type, ChatRequestError>;
		readonly history: (
			query: typeof ChatHistoryQuery.Type,
		) => Effect.Effect<typeof ChatPage.Type, ChatRequestError>;
		readonly browserView: (
			input: typeof BrowserViewRequest.Type,
		) => Effect.Effect<typeof BrowserViewResponse.Type, ChatRequestError>;
	}
>()("trajan/ChatHttp") {
	static readonly layer = Layer.effect(
		ChatHttp,
		Effect.gen(function* () {
			const client = HttpClient.withScope(yield* HttpClient.HttpClient);

			return ChatHttp.of({
				submit: (input) =>
					complete(
						HttpClientRequest.post(ChatPath).pipe(
							HttpClientRequest.schemaBodyJson(TurnSubmission)(input),
							Effect.flatMap(client.execute),
							Effect.flatMap((response) =>
								response.status === 400 ? rejectedReceipt(response) : submitReceipt(response),
							),
						),
					),
				stop: (input) =>
					complete(
						HttpClientRequest.post(ChatStopPath).pipe(
							HttpClientRequest.schemaBodyJson(ChatStop)(input),
							Effect.flatMap(client.execute),
							Effect.flatMap(stopReceipt),
						),
					),
				history: (query) =>
					complete(
						Schema.encodeEffect(ChatHistoryQuery)(query).pipe(
							Effect.flatMap((urlParams) => client.get(ChatHistoryPath, { urlParams })),
							Effect.flatMap(historyPage),
						),
					),
				browserView: (input) =>
					complete(
						HttpClientRequest.post(BrowserViewPath).pipe(
							HttpClientRequest.schemaBodyJson(BrowserViewRequest)(input),
							Effect.flatMap(client.execute),
							Effect.flatMap(browserView),
						),
						"10 seconds",
					),
			});
		}),
	);
	static readonly live = this.layer.pipe(
		Layer.provide(
			FetchHttpClient.layer.pipe(
				Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store" })),
			),
		),
	);
}
