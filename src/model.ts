import type { Context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Harness, type ModelRef } from "@earendil-works/pi-durable";

export const MODEL_ID = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

const RETIRED_MODEL_ID = "@cf/zai-org/glm-5.3-flash";

/** Pi persists the model on each conversation. Its defaults only apply when creating one. */
export async function migrateRetiredModel(pi: Harness, model: ModelRef, context: Context) {
	const root = await pi.conversation(ROOT_CONVERSATION_ID, context);
	if (!root) return;
	const { model: current } = await root.agent(context);
	if (current?.provider === model.provider && current.modelId === RETIRED_MODEL_ID) {
		await root.configure({ model }, context);
	}
}
