import { Command, Component, Subscription, UiSchema } from "@effect/ui";
import { Dialog } from "@effect/ui-kit/Dialog";
import { BrowserHost, Html, HtmlSubscription } from "@effect/ui/html";
import { Effect, Fiber, Layer, Schema, Stream } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { activitySurface, ActivityContent, BrowserFeed } from "./browser-view";
import { ChatScreen, chatScreen, dispatchChat, initialScreen, ScreenAction } from "./chat-screen";
import { Composer } from "./chat-composer";
import { followTranscript } from "./chat-scroll";
import { ChatTranscript } from "./chat-transcript";
import { Icon } from "./icons";
import { SettingsMenu } from "./settings-menu";
import { observeAtom } from "./ui-atoms";
import "./styles.css";

class ChatAction extends Command.Service<ChatAction>()("ChatAction", {
	args: { action: ScreenAction },
	mode: "queue",
}) {
	static readonly layer = this.toLayer(
		Effect.map(
			AtomRegistry.AtomRegistry,
			(registry) =>
				({ action }) =>
					Effect.sync(() => dispatchChat(registry, action)),
		),
	);
}

const Message = UiSchema.TaggedEnum({
	ScreenChanged: { screen: ChatScreen },
	Acted: { action: ScreenAction },
	BrowserToggled: { open: Schema.Boolean },
	DesktopChanged: { desktop: Schema.Boolean },
});

const browserPanel = "lg:w-[46%] lg:max-w-[60rem]";
const alertStyle = "chat-floating-surface px-4 py-2 text-sm text-danger";

const App = Html.component({
	name: "Trajan",
	model: Schema.Struct({
		screen: ChatScreen,
		browserOpen: Schema.Boolean,
		desktop: Schema.Boolean,
	}),
	message: Message,
})
	.make({
		init: () => ({
			screen: initialScreen,
			browserOpen: false,
			desktop: false,
		}),
		update: ($, message) => {
			const { model } = $;
			switch (message._tag) {
				case "ScreenChanged":
					return { ...model, screen: message.screen };
				case "BrowserToggled":
					return { ...model, browserOpen: message.open };
				case "DesktopChanged":
					return { ...model, desktop: message.desktop };
				case "Acted":
					return $.run(ChatAction.make({ action: message.action }));
			}
		},
		subscriptions: () => [
			Subscription.make(
				"chat-screen",
				observeAtom(chatScreen).pipe(Stream.map((screen) => Message.ScreenChanged({ screen }))),
			),
			HtmlSubscription.onMediaQuery("(min-width: 64rem)", (desktop) =>
				Message.DesktopChanged({ desktop }),
			),
		],
		view: (h, { screen, browserOpen, desktop }) => {
			const { status, loading, activity, notice, requestError } = screen;
			const synced = status === "open";
			const connectionLabel = synced
				? "Live"
				: status === "connecting"
					? "Connecting"
					: "Reconnecting";
			return Dialog(h, {
				props: { open: browserOpen, modal: !desktop, disablePointerDismissal: true },
				onEmit: {
					RequestedOpen: () => Message.BrowserToggled({ open: true }),
					RequestedClose: () => Message.BrowserToggled({ open: false }),
					Settled: () => undefined,
				},
				view: (dialog) =>
					h.div.class("flex h-dvh min-w-0 overflow-hidden").children(
						h.section
							.attr("aria-label", "Chat")
							.class(
								"chat-layout relative flex h-dvh min-w-0 flex-1 flex-col overflow-hidden bg-canvas text-ink",
							)
							.children(
								h.div
									.attr("data-loading-history", String(loading))
									.class("chat-transcript min-h-0 flex-1 overflow-y-auto")
									.onMount(followTranscript())
									.children(
										h.header.class("pointer-events-none sticky top-0 z-10 h-0").children(
											h.div
												.class(
													"mx-auto flex max-w-3xl items-center justify-between gap-3 px-(--chat-column-gutter) pt-(--chat-edge-gap)",
												)
												.children(
													h.div
														.class(
															"chat-floating-surface flex h-(--chat-control-height) items-center gap-2.5 px-3",
														)
														.children(
															h.h1.class("text-base font-semibold").children("Trajan"),
															h.span
																.attrs({
																	role: "status",
																	"data-tone": synced ? "success" : undefined,
																})
																.class("chat-badge")
																.children(connectionLabel),
														),
													SettingsMenu(h, {}),
												),
										),
										h.div
											.attr("data-transcript-content", "")
											.class("flex min-h-full flex-col")
											.children(
												ChatTranscript(
													h,
													screen,
													Message.Acted({ action: { type: "load-earlier" } }),
												),
												h.footer
													.class("chat-footer pointer-events-none sticky bottom-0 z-10")
													.children(
														h.div
															.class(
																"mx-auto max-w-3xl space-y-2 px-(--chat-column-gutter) py-(--chat-edge-gap)",
															)
															.children(
																notice?.status === "unconfirmed" &&
																	h.div
																		.class(
																			"chat-floating-surface flex items-center gap-3 px-4 py-2",
																		)
																		.children(
																			h.p
																				.attr("role", "status")
																				.class("min-w-0 flex-1 truncate text-sm text-muted")
																				.children(
																					`Couldn’t confirm delivery of “${notice.prompt}”.`,
																				),
																			h.button
																				.attrs({
																					type: "button",
																					disabled: synced ? undefined : "",
																				})
																				.class(
																					"chat-button chat-compact-control bg-control px-3 text-xs",
																				)
																				.on(
																					"click",
																					Message.Acted({
																						action: { type: "retry", id: notice.id },
																					}),
																				)
																				.children("Retry sending"),
																		),
																notice?.status === "rejected" &&
																	h.p
																		.attr("role", "alert")
																		.class(alertStyle)
																		.children(notice.message),
																requestError &&
																	h.p
																		.attr("role", "alert")
																		.class(alertStyle)
																		.children(requestError),
																activity &&
																	(activity.kind === "browser" && activity.inspectable
																		? dialog
																				.trigger(h.button)
																				.attr("aria-description", "Open live browser")
																				.class(`chat-button ${activitySurface}`)
																				.children(
																					ActivityContent(h, activity),
																					Icon(h, "chevron", 12, "-rotate-90 text-muted"),
																				)
																		: h.p
																				.attr("role", "status")
																				.class(`${activitySurface} text-muted`)
																				.children(ActivityContent(h, activity))),
																Composer(h, screen, {
																	submit: Message.Acted({ action: { type: "submit" } }),
																	stop: Message.Acted({ action: { type: "stop" } }),
																}),
															),
													),
											),
									),
							),
						browserOpen && h.div.class(`${browserPanel} lg:shrink-0`),
						dialog
							.portal(h.dialog.key("live-browser-dialog"))
							?.attr("aria-modal", desktop ? "false" : "true")
							.class("h-dvh! w-dvw! lg:left-auto! lg:w-[46%]! lg:max-w-[60rem]!")
							.children(
								dialog
									.popup(h.div.key("live-browser-panel"))
									.class(
										`browser-viewer pointer-events-auto fixed inset-0 flex min-h-0 flex-col bg-canvas text-ink outline-none lg:left-auto lg:border-l lg:border-line ${browserPanel}`,
									)
									.children(
										h.div
											.class(
												"flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3",
											)
											.children(
												dialog.title(h.h2).class("text-sm font-semibold").children("Live browser"),
												dialog
													.close(h.button)
													.attr("aria-label", "Close live browser view")
													.class(
														"chat-button chat-compact-control w-(--chat-compact-control-height) border border-line",
													)
													.children(Icon(h, "close")),
											),
										browserOpen && BrowserFeed(h, {}),
									),
							),
					),
			});
		},
	})
	.pipe(Component.provide(ChatAction.layer.pipe(Layer.provideMerge(AtomRegistry.layer))));

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing #root element");
}
const app = BrowserHost.mount(App, {}, root).pipe(Layer.launch, Effect.runFork);
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		Effect.runFork(Fiber.interrupt(app));
	});
}
