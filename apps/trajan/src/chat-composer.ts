import { Mount } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Effect } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { draftAtom } from "./chat-screen";
import type { ChatScreen } from "./chat-screen";
import { Icon } from "./icons";

// The browser owns the editable value, so incoming stream updates cannot
// rewind a keystroke or disturb the caret. The atom still owns draft recovery.
const bindDraft = Mount.make("BindChatDraft", {}, (node: HTMLTextAreaElement) =>
	Effect.acquireRelease(
		Effect.gen(function* () {
			const registry = yield* AtomRegistry.AtomRegistry;
			const events = new AbortController();
			let composing = false;
			const unsubscribe = registry.subscribe(
				draftAtom,
				({ text }) => {
					if (!composing && node.value !== text) {
						node.value = text;
					}
				},
				{ immediate: true },
			);

			const recordEdit = () => {
				const text = node.value;
				if (registry.get(draftAtom).text !== text) {
					registry.set(draftAtom, { text });
				}
			};
			const options = { signal: events.signal };
			node.addEventListener("input", recordEdit, options);
			node.addEventListener(
				"compositionstart",
				() => {
					composing = true;
				},
				options,
			);
			node.addEventListener(
				"compositionend",
				() => {
					composing = false;
					recordEdit();
				},
				options,
			);
			return () => {
				events.abort();
				unsubscribe();
			};
		}),
		(dispose) => Effect.sync(dispose),
	).pipe(Effect.andThen(Effect.never)),
);

export function Composer<M>(
	h: Html.H<M>,
	screen: typeof ChatScreen.Type,
	{ submit, stop }: { readonly submit: M; readonly stop: M },
) {
	const { canSubmit, submitting, running, stopping, status } = screen;
	return h.form
		.attr("aria-busy", String(submitting))
		.on("submit", submit, { preventDefault: true })
		.class("flex items-end gap-2")
		.children(
			h.div
				.class(
					"chat-floating-surface flex min-h-(--chat-control-height) min-w-0 flex-1 items-center px-4 py-2 focus-within:ring-2 focus-within:ring-focus-ring",
				)
				.children(
					h.textarea
						.onMount(bindDraft())
						.attrs({
							"aria-label": "Message Trajan",
							rows: "1",
							placeholder: running ? "Add a follow-up" : "Message Trajan",
						})
						.class(
							"chat-composer field-sizing-content max-h-[min(8rem,30dvh)] w-full min-w-0 resize-none overflow-y-auto bg-transparent text-sm leading-6 outline-none placeholder:text-muted",
						)
						.on(
							"keydown",
							({ key, shift, composing }) =>
								key === "Enter" && !shift && !composing ? submit : undefined,
							{ preventDefault: true },
						),
				),
			running &&
				h.button
					.attrs({
						type: "button",
						"aria-label": "Stop",
						disabled: status !== "open" || stopping ? "" : undefined,
					})
					.class("chat-button chat-floating-surface size-(--chat-control-height)")
					.on("click", stop)
					.children(Icon(h, "stop", 12)),
			h.button
				.attrs({
					type: "submit",
					"data-send-message": "",
					"aria-label": running ? "Queue follow-up" : "Send message",
					disabled: canSubmit ? undefined : "",
				})
				.class("chat-button chat-floating-surface send-button size-(--chat-control-height)")
				.children(Icon(h, "arrowUp")),
		);
}
