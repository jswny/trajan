import type { OpenAiResponsesTransport } from "@trajan/model-openai";

export function openAiGatewayTransport(gateway: Pick<AiGateway, "run">): OpenAiResponsesTransport {
	return (query, signal) =>
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
		);
}
