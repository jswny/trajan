import type { Context } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Harness, type ModelRef } from "@earendil-works/pi-durable";
import { Effect } from "effect";

const RETIRED_MODEL_ID = "@cf/zai-org/glm-5.3-flash";

/** Pi persists the model on each conversation. Its defaults only apply when creating one. */
export const migrateRetiredModel = Effect.fn("migrateRetiredModel")(function* (
	pi: Harness,
	model: ModelRef,
	context: Context,
) {
	const root = yield* Effect.tryPromise({
		try: () => pi.conversation(ROOT_CONVERSATION_ID, context),
		catch: (error) => error,
	});
	if (!root) return;
	const { model: current } = yield* Effect.tryPromise({
		try: () => root.agent(context),
		catch: (error) => error,
	});
	if (current?.provider === model.provider && current.modelId === RETIRED_MODEL_ID) {
		yield* Effect.tryPromise({
			try: () => root.configure({ model }, context),
			catch: (error) => error,
		});
	}
});
