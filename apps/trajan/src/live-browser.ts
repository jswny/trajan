import { codeModeError } from "@trajan/code-mode";
import type { Browser } from "agents/browser";
import { Clock, Effect, Option, Schema } from "effect";
import { browserKeepAliveMs } from "./browser";
import type { BrowserPageStatus } from "./browser";
import { BrowserViewRequest, BrowserViewResponse, BrowserWatch } from "./chat/protocol";

const decodeBrowserView = Schema.decodeUnknownEffect(BrowserViewResponse);
const decodeBrowserViewRequest = Schema.decodeUnknownOption(
	Schema.fromJsonString(BrowserViewRequest),
);
export const browserViewHeaders = { "Cache-Control": "no-store" };
const browserViewLeaseMs = 60_000;
const browserWatchKey = "trajan:browser-watch";
const decodeBrowserWatch = Schema.decodeUnknownOption(BrowserWatch);

export function createLiveBrowser(
	storage: Pick<DurableObjectStorage, "kv">,
	browser: Pick<Browser, "liveView">,
	binding: Pick<Env["BROWSER"], "getLiveView">,
	publishAvailability: () => void,
) {
	function watch() {
		return Option.getOrNull(decodeBrowserWatch(storage.kv.get(browserWatchKey)));
	}

	function changeAvailability(status: BrowserPageStatus) {
		return Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const previous = watch();
			const next =
				status === "closed"
					? null
					: {
							id:
								status === "open" && previous && previous.expiresAt > now
									? previous.id
									: yield* Effect.sync(() => crypto.randomUUID()),
							expiresAt: now + browserKeepAliveMs,
						};
			yield* Effect.try({
				try: () => {
					if (next === null) {
						storage.kv.delete(browserWatchKey);
					} else {
						storage.kv.put(browserWatchKey, next);
					}
					publishAvailability();
				},
				catch: codeModeError,
			});
		});
	}

	function requestView(request: Request) {
		return Effect.gen(function* () {
			const input = decodeBrowserViewRequest(yield* Effect.tryPromise(() => request.text()));
			if (input._tag === "None") {
				return new Response(null, { status: 400, headers: browserViewHeaders });
			}
			const selected = watch();
			const now = yield* Clock.currentTimeMillis;
			if (selected?.id !== input.value.id || selected.expiresAt <= now) {
				return Response.json({ status: "closed" }, { headers: browserViewHeaders });
			}
			const view = yield* Effect.tryPromise(() => browser.liveView({ mode: "tab" }));
			const target = view?.targets.find(
				(tab) => tab.type === "page" && tab.pageUrl?.startsWith("https:"),
			);
			if (!view || !target) {
				const current = watch();
				if (current?.id === selected.id && current.expiresAt === selected.expiresAt) {
					yield* changeAvailability("closed");
				}
				return Response.json({ status: "closed" }, { headers: browserViewHeaders });
			}
			const expiresAt = (yield* Clock.currentTimeMillis) + browserViewLeaseMs;
			const link = yield* Effect.tryPromise(() =>
				binding.getLiveView(view.sessionId, {
					targetId: target.targetId,
					mode: "tab",
					expiresInMs: browserViewLeaseMs,
					guardrails: { mode: "readonly" },
				}),
			);
			if (link.options.guardrails?.mode !== "readonly") {
				return new Response(null, { status: 502, headers: browserViewHeaders });
			}
			const current = watch();
			const checkedAt = yield* Clock.currentTimeMillis;
			if (current?.id !== selected.id || current.expiresAt <= checkedAt) {
				return Response.json({ status: "closed" }, { headers: browserViewHeaders });
			}
			const payload = yield* decodeBrowserView({
				status: "open",
				url: link.devtoolsFrontendUrl,
				expiresAt,
			});
			return Response.json(payload, { headers: browserViewHeaders });
		}).pipe(
			Effect.timeout("8 seconds"),
			Effect.orElseSucceed(() => new Response(null, { status: 502, headers: browserViewHeaders })),
		);
	}

	return { watch, changeAvailability, requestView };
}
