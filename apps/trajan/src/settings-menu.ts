import { Command, Component, Subscription, UiSchema } from "@effect/ui";
import { Menu } from "@effect/ui-kit/Menu";
import { Html } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { Icon } from "./icons";
import { ThemeMode, themePreference } from "./theme";
import { observeAtom } from "./ui-atoms";

class SetTheme extends Command.Service<SetTheme>()("SetTheme", { args: { mode: ThemeMode } }) {
	static readonly layer = this.toLayer(
		Effect.map(
			AtomRegistry.AtomRegistry,
			(registry) =>
				({ mode }) =>
					Effect.sync(() => registry.set(themePreference, mode)),
		),
	);
}

const Message = UiSchema.TaggedEnum({
	ThemeChanged: { mode: ThemeMode },
	ThemePicked: { mode: ThemeMode },
	MenuToggled: { open: Schema.Boolean },
});

const themeItems = [
	{ value: "auto", label: "Auto" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
] as const;

export const SettingsMenu = Html.component({
	name: "SettingsMenu",
	model: Schema.Struct({ open: Schema.Boolean, mode: ThemeMode }),
	message: Message,
})
	.make({
		init: () => ({ open: false, mode: "auto" }),
		update: ($, message) => {
			switch (message._tag) {
				case "MenuToggled":
					return $.evolve({ open: message.open });
				case "ThemeChanged":
					return $.evolve({ mode: message.mode });
				case "ThemePicked":
					return $.evolve({ open: false }).run(SetTheme.make({ mode: message.mode }));
			}
		},
		subscriptions: () => [
			Subscription.make(
				"theme",
				observeAtom(themePreference).pipe(Stream.map((mode) => Message.ThemeChanged({ mode }))),
			),
		],
		view: (h, { open, mode }) =>
			Menu(h, {
				props: {
					open,
					items: themeItems,
					align: "end",
					sideOffset: 8,
					collisionPadding: 12,
					modal: false,
				},
				onEmit: {
					RequestedOpen: () => Message.MenuToggled({ open: true }),
					RequestedClose: () => Message.MenuToggled({ open: false }),
					Picked: ({ value }) => {
						const item = themeItems.find((item) => item.value === value);
						return item ? Message.ThemePicked({ mode: item.value }) : undefined;
					},
					Highlighted: () => undefined,
					RequestedQuery: () => undefined,
					Settled: () => undefined,
				},
				view: (menu) =>
					h.div.class("contents").children(
						menu
							.trigger({ element: h.button })
							.attr("aria-label", "Chat settings")
							.class("chat-button chat-floating-surface size-(--chat-control-height)")
							.children(Icon(h, "ellipsis", 18)),
						menu.positioner(h.div)?.children(
							menu
								.popup(h.div)
								.class(
									"pointer-events-auto max-h-(--available-height) w-40 overflow-y-auto overscroll-contain rounded-(--chat-surface-radius) border border-line bg-surface p-1.5 text-ink shadow-lg outline-none",
								)
								.children(
									menu.radioGroup({ element: h.div, value: mode }).children(
										h.div.class("px-3 pt-2 pb-1 text-xs font-medium text-muted").children("Theme"),
										...themeItems.map(({ value, label }) =>
											menu
												.radioItem({ element: h.div, value, closeOnClick: true })
												.class(
													"chat-compact-control flex cursor-pointer items-center justify-between gap-3 px-3 text-sm outline-none data-highlighted:bg-hover",
												)
												.children(label, value === mode && Icon(h, "check", 16, "text-accent")),
										),
									),
								),
						),
					),
			}),
	})
	.pipe(Component.provide(SetTheme.layer));
