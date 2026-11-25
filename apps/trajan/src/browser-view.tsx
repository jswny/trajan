import { Dialog } from "@base-ui/react/dialog";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { IconX } from "@pierre/icons/beta";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { ChatHttp } from "./chat/http-client";
import { browserWatchId } from "./use-chat-session";

const openAtom = Atom.make(false);
const viewAtom = Atom.make((get) => {
	const id = get(browserWatchId);
	return get(openAtom) && id
		? ChatHttp.use((http) => http.browserView({ id })).pipe(Effect.provide(ChatHttp.live))
		: Effect.succeed(null);
}).pipe(Atom.setIdleTTL(0));

const desktopQuery = "(min-width: 64rem)";
function desktopMatches() {
	return window.matchMedia(desktopQuery).matches;
}
function watchDesktop(change: () => void) {
	const query = window.matchMedia(desktopQuery);
	query.addEventListener("change", change);
	return () => query.removeEventListener("change", change);
}

function BrowserFeed() {
	const result = useAtomValue(viewAtom);
	const refresh = useAtomRefresh(viewAtom);
	const available = useAtomValue(browserWatchId) !== null;
	const view = AsyncResult.getOrElse(result, () => null);
	if (!available) {
		return (
			<p role="status" className="m-auto px-6 text-sm text-muted">
				Browser closed
			</p>
		);
	}
	if (result.waiting || result._tag === "Initial") {
		return (
			<p role="status" className="m-auto px-6 text-sm text-muted">
				Connecting to browser…
			</p>
		);
	}
	if (result._tag === "Failure") {
		return (
			<div className="m-auto flex flex-col items-center gap-3 px-6 text-center">
				<p role="alert" className="text-sm text-muted">
					Couldn’t connect to the live browser.
				</p>
				<button
					className="chat-button chat-compact-control border border-line px-4 text-sm"
					type="button"
					onClick={refresh}
				>
					Try again
				</button>
			</div>
		);
	}
	if (view?.status === "closed") {
		return (
			<p role="status" className="m-auto px-6 text-sm text-muted">
				Browser closed
			</p>
		);
	}
	return view?.status === "open" ? (
		<iframe
			className="min-h-0 w-full flex-1 border-0"
			title="Trajan’s live browser"
			src={view.url}
			referrerPolicy="no-referrer"
		/>
	) : null;
}

export function BrowserViewer({ children }: { children: ReactNode }) {
	const [open, setOpen] = useAtom(openAtom);
	const [dock, setDock] = useState<HTMLDivElement | null>(null);
	const desktop = useSyncExternalStore(watchDesktop, desktopMatches);
	return (
		<Dialog.Root open={open} onOpenChange={setOpen} modal={!desktop} disablePointerDismissal>
			<div className="flex h-dvh min-w-0 overflow-hidden">
				{children}
				<div
					ref={setDock}
					className={open ? "lg:w-[46%] lg:max-w-[60rem] lg:shrink-0" : undefined}
				/>
			</div>
			{dock && open ? (
				<Dialog.Portal container={dock}>
					<Dialog.Popup
						aria-modal={desktop ? undefined : true}
						className="browser-viewer fixed inset-0 z-30 flex min-h-0 flex-col bg-canvas text-ink outline-none lg:static lg:h-dvh lg:border-l lg:border-line"
					>
						<div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
							<Dialog.Title className="text-sm font-semibold">Live browser</Dialog.Title>
							<Dialog.Close
								aria-label="Close live browser view"
								className="chat-button chat-compact-control w-(--chat-compact-control-height) border border-line"
							>
								<IconX size={16} aria-hidden="true" />
							</Dialog.Close>
						</div>
						<BrowserFeed />
					</Dialog.Popup>
				</Dialog.Portal>
			) : null}
		</Dialog.Root>
	);
}
