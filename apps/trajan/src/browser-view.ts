import { Command, Component, Subscription, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Clock, Effect, Schema, Stream } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { browserWatchId } from "./chat-screen";
import type { ChatActivity } from "./chat-screen";
import { ChatHttp } from "./chat/http-client";
import { BrowserViewResponse } from "./chat/protocol";
import { Icon } from "./icons";
import { observeAtom } from "./ui-atoms";

const viewAtom = Atom.make((get) => {
	const id = get(browserWatchId);
	return id
		? ChatHttp.use((http) => http.browserView({ id })).pipe(Effect.provide(ChatHttp.live))
		: Effect.succeed(null);
}).pipe(Atom.setIdleTTL(0));

const leaseExpired = Atom.make((get) => {
	const view = AsyncResult.getOrElse(get(viewAtom), () => null);
	if (view?.status !== "open") {
		return Stream.succeed(false);
	}
	return Stream.fromEffect(Clock.currentTimeMillis).pipe(
		Stream.flatMap((now) =>
			view.expiresAt <= now
				? Stream.succeed(true)
				: Stream.concat(
						Stream.succeed(false),
						Stream.fromEffect(Effect.sleep(view.expiresAt - now).pipe(Effect.as(true))),
					),
		),
	);
});

const BrowserStatus = Schema.Union([
	Schema.Struct({ status: Schema.Literals(["connecting", "failed", "closed"]) }),
	Schema.Struct({
		status: Schema.Literal("open"),
		url: BrowserViewResponse.members[1].fields.url,
		expired: Schema.Boolean,
	}),
]);
const feed = Atom.make((get): typeof BrowserStatus.Type => {
	const id = get(browserWatchId);
	const result = get(viewAtom);
	if (!id) {
		return { status: "closed" };
	}
	if (result.waiting || result._tag === "Initial") {
		return { status: "connecting" };
	}
	if (result._tag === "Failure") {
		return { status: "failed" };
	}
	const view = result.value;
	return view?.status === "open"
		? {
				status: "open",
				url: view.url,
				expired: AsyncResult.getOrElse(get(leaseExpired), () => false),
			}
		: { status: "closed" };
});

class RefreshBrowser extends Command.Service<RefreshBrowser>()("RefreshBrowser", {}) {
	static readonly layer = this.toLayer(
		Effect.map(
			AtomRegistry.AtomRegistry,
			(registry) => () => Effect.sync(() => registry.refresh(viewAtom)),
		),
	);
}

const FeedMessage = UiSchema.TaggedEnum({ Changed: { browser: BrowserStatus }, Refresh: {} });
export const BrowserFeed = Html.component({
	name: "BrowserFeed",
	model: BrowserStatus,
	message: FeedMessage,
})
	.make({
		init: () => ({ status: "connecting" }),
		update: ($, message) => {
			if (message._tag === "Changed") {
				return message.browser;
			}
			return $.run(RefreshBrowser.make());
		},
		subscriptions: () => [
			Subscription.make(
				"browser-view",
				observeAtom(feed).pipe(Stream.map((browser) => FeedMessage.Changed({ browser }))),
			),
		],
		view: (h, model) => {
			if (model.status === "open") {
				return h.div.class("contents").children(
					model.expired &&
						h.button
							.attrs({ type: "button" })
							.class("chat-button m-2 self-end px-3 py-1 text-xs text-muted")
							.on("click", FeedMessage.Refresh())
							.children("Reconnect live view"),
					h.iframe.key("live-browser").class("min-h-0 w-full flex-1 border-0").attrs({
						title: "Trajan’s live browser",
						src: model.url,
						referrerpolicy: "no-referrer",
					}),
				);
			}
			if (model.status === "failed") {
				return h.div
					.class("m-auto flex flex-col items-center gap-3 px-6 text-center")
					.children(
						h.p
							.attr("role", "alert")
							.class("text-sm text-muted")
							.children("Couldn’t connect to the live browser."),
						h.button
							.attr("type", "button")
							.class("chat-button chat-compact-control border border-line px-4 text-sm")
							.on("click", FeedMessage.Refresh())
							.children("Try again"),
					);
			}
			return h.p
				.attr("role", "status")
				.class("m-auto px-6 text-sm text-muted")
				.children(model.status === "closed" ? "Browser closed" : "Connecting to browser…");
		},
	})
	.pipe(Component.provide(RefreshBrowser.layer));

const labels = { waiting: "Waiting for the model", responding: "Responding", stopping: "Stopping" };
export const activitySurface = "chat-floating-surface chat-activity-chip";

export function ActivityContent<M>(h: Html.H<M>, activity: ChatActivity) {
	const browser = activity.kind === "browser";
	const label = browser
		? activity.working
			? "Browsing"
			: "Browser open"
		: activity.kind === "tool"
			? `Running ${activity.name}`
			: labels[activity.kind];
	return h.div
		.class("contents")
		.children(
			browser
				? Icon(h, "globe")
				: Icon(h, "loader", 16, "motion-safe:animate-spin motion-reduce:animate-pulse"),
			label,
		);
}
