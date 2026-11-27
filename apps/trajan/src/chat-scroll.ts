import { Mount } from "@effect/ui";
import { Effect } from "effect";

const bottomThreshold = 32;
const isElement = (target: EventTarget | null): target is Element =>
	target !== null && "nodeType" in target && target.nodeType === Node.ELEMENT_NODE;

export const followTranscript = Mount.make("FollowTranscript", {}, (scroller: HTMLDivElement) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const content = scroller.querySelector("[data-transcript-content]");
			if (!content) {
				return () => {};
			}
			let following = true;
			let lastScrollTop = 0;
			let anchor: { element: Element; offset: number } | undefined;
			const atBottom = () =>
				scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= bottomThreshold;

			const resize = new ResizeObserver(() => {
				if (following && !anchor) {
					scroller.scrollTop = scroller.scrollHeight;
					lastScrollTop = scroller.scrollTop;
				}
			});
			resize.observe(scroller);
			resize.observe(content);

			// Restore the first visible entry after a history page commits.
			const history = new MutationObserver(() => {
				if (scroller.getAttribute("data-loading-history") !== "false" || !anchor) {
					return;
				}
				if (anchor.element.isConnected) {
					scroller.scrollTop += anchor.element.getBoundingClientRect().top - anchor.offset;
					lastScrollTop = scroller.scrollTop;
				}
				anchor = undefined;
			});
			history.observe(scroller, { attributes: true, attributeFilter: ["data-loading-history"] });

			const events = new AbortController();
			const listen = { signal: events.signal, capture: true };
			scroller.addEventListener(
				"scroll",
				() => {
					if (atBottom()) {
						following = true;
					} else if (scroller.scrollTop < lastScrollTop - 1) {
						following = false;
					}
					lastScrollTop = scroller.scrollTop;
				},
				{ signal: events.signal },
			);
			scroller.addEventListener(
				"click",
				(event) => {
					if (!isElement(event.target)) {
						return;
					}
					if (event.target.closest(".chat-tool-card summary, [data-inspect]")) {
						// Inspection can grow across native toggle, render, and lazy preview loading.
						following = false;
					}
					if (event.target.closest("[data-load-earlier]")) {
						const top = scroller.getBoundingClientRect().top;
						const visible = Array.from(scroller.querySelectorAll("[data-chat-entry]")).find(
							(entry) => entry.getBoundingClientRect().bottom > top,
						);
						if (visible) {
							following = false;
							anchor = { element: visible, offset: visible.getBoundingClientRect().top };
						}
					}
				},
				listen,
			);
			const resumeFollowing = () => {
				if (scroller.querySelector("[data-send-message]:not(:disabled)")) {
					following = true;
				}
			};
			scroller.addEventListener("submit", resumeFollowing, listen);
			scroller.addEventListener(
				"keydown",
				(event) => {
					if (
						isElement(event.target) &&
						event.target.matches("textarea") &&
						event.key === "Enter" &&
						!event.shiftKey &&
						!event.isComposing
					) {
						resumeFollowing();
					}
				},
				listen,
			);

			return () => {
				resize.disconnect();
				history.disconnect();
				events.abort();
			};
		}),
		(dispose) => Effect.sync(dispose),
	).pipe(Effect.andThen(Effect.never)),
);
