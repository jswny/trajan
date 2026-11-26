import { useAtomValue } from "@effect/atom-react";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, useState } from "react";
import { ToolCode } from "./chat-markdown";

const unopenedScript = Atom.make(AsyncResult.initial<string>());

export function ExecScript({
	source,
	open,
	onInspect,
}: {
	source: string;
	open: boolean;
	onInspect: () => void;
}) {
	const [showOriginal, setShowOriginal] = useState(false);
	const formattedScript = useMemo(
		() =>
			Atom.make(
				Effect.tryPromise(async () => {
					const { formatExecScript } = await import("./format-exec-script");
					return formatExecScript(source);
				}).pipe(Effect.orElseSucceed(() => source)),
			),
		[source],
	);
	const formatted = AsyncResult.getOrElse(
		useAtomValue(open ? formattedScript : unopenedScript),
		() => source,
	);
	return (
		<div>
			<div className="mb-1 flex items-center justify-between gap-2">
				<p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Script</p>
				{formatted !== source ? (
					<button
						type="button"
						aria-pressed={showOriginal}
						className="chat-button chat-compact-control px-3 text-xs text-muted aria-pressed:bg-control aria-pressed:text-ink"
						onClick={() => {
							onInspect();
							setShowOriginal((show) => !show);
						}}
					>
						Original
					</button>
				) : null}
			</div>
			<ToolCode
				text={showOriginal ? source : formatted}
				language={open ? "js" : undefined}
				preserveLines
			/>
		</div>
	);
}
