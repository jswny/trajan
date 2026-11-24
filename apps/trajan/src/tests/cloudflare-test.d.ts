import type { EffectHarnessTestObject } from "./effect-harness-fixture";

declare global {
	namespace Cloudflare {
		interface Env {
			EFFECT_HARNESS_TEST: DurableObjectNamespace<EffectHarnessTestObject>;
		}
	}
}

export {};
