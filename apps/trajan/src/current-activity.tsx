import { Dialog } from "@base-ui/react/dialog";
import { useAtomValue } from "@effect/atom-react";
import { IconChevron, IconGlobe, IconLoader } from "@pierre/icons/beta";
import { browserWatchId } from "./use-chat-session";

const surface = "chat-floating-surface chat-activity-chip";

export function CurrentActivityChip({
	turnStatus,
	browsing,
	connected,
}: {
	turnStatus: string | null;
	browsing: boolean;
	connected: boolean;
}) {
	const browserOpen = useAtomValue(browserWatchId) !== null;
	const showBrowser = browsing || (turnStatus === null && browserOpen);
	const label = showBrowser ? (browsing ? "Browsing" : "Browser open") : turnStatus;
	if (label === null) {
		return null;
	}
	const content = (
		<>
			{showBrowser ? (
				<IconGlobe size={16} aria-hidden="true" />
			) : (
				<IconLoader
					size={16}
					aria-hidden="true"
					className="motion-safe:animate-spin motion-reduce:animate-pulse"
				/>
			)}
			{label}
		</>
	);
	return showBrowser && browserOpen && connected ? (
		<Dialog.Trigger className={`chat-button ${surface}`} aria-description="Open live browser">
			{content}
			<IconChevron size={12} aria-hidden="true" className="-rotate-90 text-muted" />
		</Dialog.Trigger>
	) : (
		<p role="status" className={`${surface} text-muted`}>
			{content}
		</p>
	);
}
