import type { ChatTestObject } from "./chat-runtime-fixture";

declare global {
	namespace Cloudflare {
		interface Env {
			CHAT_TEST: DurableObjectNamespace<ChatTestObject>;
		}
	}
}

export {};
