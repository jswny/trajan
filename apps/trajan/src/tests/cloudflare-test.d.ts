import type { EffectHarnessTestObject } from "./effect-harness-fixture";
import type { PiHarnessTestObject } from "./worker";

declare global {
	namespace Cloudflare {
		interface Env {
			EFFECT_HARNESS_TEST: DurableObjectNamespace<EffectHarnessTestObject>;
			PI_HARNESS_TEST: DurableObjectNamespace<PiHarnessTestObject>;
		}
	}
}

export {};
