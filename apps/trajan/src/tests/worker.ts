export { EffectHarnessTestObject } from "./effect-harness-fixture";
import { isEffectChatPath } from "../effect-harness/chat-protocol";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/__browser-smoke/ready") {
			return new Response("Trajan browser fixture");
		}
		const origin = request.headers.get("Origin");
		if (origin !== null && origin !== url.origin) {
			return new Response(null, { status: 403 });
		}
		const fixture = /(?:^|;\s*)trajan-fixture=([a-f0-9-]+)(?:;|$)/.exec(
			request.headers.get("Cookie") ?? "",
		)?.[1];
		const stub = env.EFFECT_HARNESS_TEST.getByName(fixture ?? "test-chat");
		if (isEffectChatPath(url.pathname)) {
			return stub.fetch(request);
		}
		const action =
			/^\/__browser-smoke\/effect-stream\/(pause|pause-replay|pause-replay-edit|release|crash|state)$/.exec(
				url.pathname,
			)?.[1];
		if (action && fixture && request.method === "POST") {
			switch (action) {
				case "pause":
					await stub.pause("during-reply");
					return new Response(null, { status: 204 });
				case "pause-replay":
					await stub.pause("during-replay-read");
					return new Response(null, { status: 204 });
				case "pause-replay-edit":
					await stub.pause("during-replay-edit");
					return new Response(null, { status: 204 });
				case "release":
					await stub.release();
					return new Response(null, { status: 204 });
				case "crash":
					await stub.crash();
					return new Response(null, { status: 204 });
				case "state":
					return Response.json(await stub.state());
			}
		}
		return new Response(null, { status: 404 });
	},
};
