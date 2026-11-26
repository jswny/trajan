import { Dialog } from "@base-ui/react/dialog";
import { IconChevron, IconGlobe, IconLoader } from "@pierre/icons/beta";
import type { ChatActivity } from "./use-chat-session";

const surface = "chat-floating-surface chat-activity-chip";

const labels = { waiting: "Waiting for the model", responding: "Responding", stopping: "Stopping" };

export function CurrentActivityChip({ activity }: { activity: ChatActivity | null }) {
	if (!activity) {
		return null;
	}
	const showBrowser = activity.kind === "browser";
	const label = showBrowser
		? activity.working
			? "Browsing"
			: "Browser open"
		: activity.kind === "tool"
			? `Running ${activity.name}`
			: labels[activity.kind];
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
	return showBrowser && activity.inspectable ? (
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
