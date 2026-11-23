import { Effect, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { readPreference, writePreference } from "./browser-storage";
import { PiSession, type PromptDraft, type SubmitMode } from "./pi-session";

const SESSION_KEY = "trajan-session";

function createSessionId(): string {
	const id = crypto.randomUUID();
	writePreference(SESSION_KEY, id);
	return id;
}

export const selectedSessionId = Atom.writable<string, void>(
	() => readPreference(SESSION_KEY) || createSessionId(),
	(ctx) => ctx.setSelf(createSessionId()),
).pipe(Atom.keepAlive);

type ComposerAction = { type: "edit"; text: string } | { type: "submit"; whenBusy: SubmitMode };
type ComposerView = { text: string; submitting: boolean; canSubmit: boolean };
const EMPTY_DRAFT: PromptDraft = { text: "" };

export function makeSessionAtoms(live: typeof PiSession.live = (id) => PiSession.live(id)) {
	const draftAtom = Atom.make(EMPTY_DRAFT).pipe(Atom.keepAlive);
	const sessionFor = Atom.family((id: string) => {
		const updates = Stream.unwrap(
			Effect.map(PiSession, ({ changes, dispatch }) =>
				Stream.map(changes, (state) => ({ state, dispatch })),
			),
		);
		return Atom.make(({ registry }) =>
			updates.pipe(
				Stream.provide(live(id)),
				Stream.tap(({ state: { submission } }) =>
					Effect.sync(() => {
						if (
							submission?.status === "accepted" &&
							registry.get(selectedSessionId) === id &&
							registry.get(draftAtom) === submission.draft
						) {
							registry.set(draftAtom, EMPTY_DRAFT);
						}
					}),
				),
			),
		).pipe(Atom.setIdleTTL(0));
	});
	const activeSessionAtom = Atom.make((get) => {
		const id = get(selectedSessionId);
		return { id, session: get(sessionFor(id)) };
	}).pipe(Atom.setIdleTTL(0));
	const composerAtom = Atom.writable<ComposerView, ComposerAction>(
		(get) => {
			const draft = get(draftAtom);
			const session = AsyncResult.getOrElse(get(activeSessionAtom).session, () => undefined);
			const submission = session?.state.submission;
			const currentSubmission = submission?.draft === draft ? submission.status : undefined;
			return {
				text: draft.text,
				submitting: currentSubmission === "pending",
				canSubmit:
					session?.state.status === "open" &&
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
			const session = AsyncResult.getOrElse(ctx.get(activeSessionAtom).session, () => undefined);
			session?.dispatch({ type: "submit", draft: ctx.get(draftAtom), whenBusy: action.whenBusy });
		},
	);
	return { activeSessionAtom, composerAtom };
}

export const { activeSessionAtom, composerAtom } = makeSessionAtoms();
