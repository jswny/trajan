import { Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { PiSession, type PromptDraft, type SubmitMode } from "./pi-session";

type ComposerAction = { type: "edit"; text: string } | { type: "submit"; whenBusy: SubmitMode };
type ComposerView = { text: string; submitting: boolean; canSubmit: boolean };
const EMPTY_DRAFT: PromptDraft = { text: "" };

export function makeSessionAtoms(live = PiSession.live()) {
	const draftAtom = Atom.make(EMPTY_DRAFT).pipe(Atom.keepAlive);
	const sessionAtom = Atom.make(({ registry }) =>
		Stream.unwrap(
			Effect.map(PiSession, ({ changes, dispatch }) =>
				Stream.map(changes, (state) => ({ state, dispatch })),
			),
		).pipe(
			Stream.provide(live),
			Stream.tap(({ state: { submission } }) =>
				Effect.sync(() => {
					if (submission?.status === "accepted" && registry.get(draftAtom) === submission.draft) {
						registry.set(draftAtom, EMPTY_DRAFT);
					}
				}),
			),
		),
	).pipe(Atom.setIdleTTL(0));
	const composerAtom = Atom.writable<ComposerView, ComposerAction>(
		(get) => {
			const draft = get(draftAtom);
			const session = AsyncResult.getOrElse(get(sessionAtom), () => undefined);
			const submission = session?.state.submission;
			const currentSubmission = submission?.draft === draft ? submission.status : undefined;
			return {
				text: draft.text,
				submitting: currentSubmission === "pending",
				canSubmit:
					session?.state.status === "open" &&
					session.state.transcriptStatus === "synced" &&
					currentSubmission !== "pending" &&
					currentSubmission !== "unconfirmed" &&
					draft.text.trim() !== "",
			};
		},
		(ctx, action) => {
			if (action.type === "edit") {
				ctx.set(draftAtom, { text: action.text });
				return;
			}
			if (!ctx.get(composerAtom).canSubmit) return;
			const session = AsyncResult.getOrElse(ctx.get(sessionAtom), () => undefined);
			session?.dispatch({ type: "submit", draft: ctx.get(draftAtom), whenBusy: action.whenBusy });
		},
	);
	return { sessionAtom, composerAtom };
}

export const { sessionAtom, composerAtom } = makeSessionAtoms();
