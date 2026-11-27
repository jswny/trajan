export const modelConfig = {
	id: "gpt-6.2-sol",
	reasoningEffort: "medium",
	compactThreshold: 200_000,
	runtimeLabels: {
		outcome: "Trajan runtime outcome",
		uncertainEffects: "Trajan runtime reported uncertain effects",
	},
} as const;
