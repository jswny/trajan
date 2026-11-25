import { TurnModelError } from "@trajan/harness";
import type { OpenAiResponsesTransport } from "@trajan/model-openai";
import { Effect } from "effect";

export function openAiGatewayTransport(gateway: Pick<AiGateway, "run">): OpenAiResponsesTransport {
	return (query, signal) =>
		Effect.tryPromise({
			try: () =>
				gateway.run(
					[
						{
							provider: "openai",
							endpoint: "v1/responses",
							headers: {
								"Content-Type": "application/json",
								"cf-aig-skip-cache": "true",
								"cf-aig-collect-log-payload": "false",
								"cf-aig-metadata": '{"app":"trajan"}',
							},
							query,
						},
					],
					{ signal },
				),
			catch: (cause) =>
				new TurnModelError({
					message: cause instanceof Error ? cause.message : "OpenAI request failed.",
					cause,
				}),
		});
}
