import { ConversationMessage, TurnMessage, TurnTranscript } from "@trajan/effect-harness";
import type { TurnSubmission } from "@trajan/effect-harness";
import { Schema } from "effect";

const contextTurnLimit = 16;
const contextByteLimit = 32_000;
const messageJson = Schema.fromJsonString(TurnMessage);
const contextJson = Schema.fromJsonString(ConversationMessage);
const transcriptJson = Schema.fromJsonString(TurnTranscript);

export const HistoryQuery = Schema.Struct({
	before: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
	limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});

type SubmissionRow = {
	seq: number;
	run_id: string;
	submission_id: string;
	prompt: string;
	state: "pending" | "running" | "completed" | "failed";
	context_through: number | null;
	error: string | null;
};

type EntryRow = { seq: number; submission_id: string; message: string };

export class ConversationStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	initialize() {
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS effect_submissions (
				seq INTEGER PRIMARY KEY,
				run_id TEXT UNIQUE NOT NULL,
				submission_id TEXT UNIQUE NOT NULL,
				prompt TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'pending',
				context_through INTEGER,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS effect_submissions_pending
				ON effect_submissions(seq) WHERE state IN ('pending', 'running');
			CREATE TABLE IF NOT EXISTS effect_entries (
				seq INTEGER PRIMARY KEY,
				submission_seq INTEGER NOT NULL REFERENCES effect_submissions(seq),
				role TEXT NOT NULL,
				message TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS effect_entries_submission ON effect_entries(submission_seq, seq);
			CREATE INDEX IF NOT EXISTS effect_entries_context ON effect_entries(seq)
				WHERE role IN ('user', 'assistant');
		`);
	}

	admit(submission: typeof TurnSubmission.Type) {
		return this.storage.transactionSync(() => {
			const existing = this.storage.sql
				.exec<Pick<SubmissionRow, "run_id">>(
					"SELECT run_id FROM effect_submissions WHERE submission_id = ?",
					submission.id,
				)
				.toArray()[0];
			if (existing) {
				return { runId: existing.run_id, accepted: false };
			}

			const runId = crypto.randomUUID();
			this.storage.sql.exec(
				"INSERT INTO effect_submissions (run_id, submission_id, prompt) VALUES (?, ?, ?)",
				runId,
				submission.id,
				submission.prompt,
			);
			return { runId, accepted: true };
		});
	}

	head(): SubmissionRow | undefined {
		return this.storage.sql
			.exec<SubmissionRow>(`
			SELECT * FROM effect_submissions WHERE state IN ('pending', 'running') ORDER BY seq LIMIT 1
		`)
			.toArray()[0];
	}

	start(runId: string) {
		return this.storage.transactionSync(() => {
			const row = this.#find(runId);
			if (!row) {
				throw new Error("The accepted submission is missing.");
			}
			if (row.state !== "pending") {
				return row;
			}
			if (this.head()?.run_id !== runId) {
				throw new Error("Only the first pending turn can start.");
			}

			// The committed prefix remains the model's context across journal replay.
			return this.storage.sql
				.exec<SubmissionRow>(
					`
				UPDATE effect_submissions SET state = 'running',
					context_through = (SELECT COALESCE(MAX(seq), 0) FROM effect_entries)
				WHERE run_id = ? RETURNING *
			`,
					runId,
				)
				.one();
		});
	}

	context(through: number) {
		// Count whole exchanges before loading message bodies into the Worker.
		return this.storage.sql
			.exec<Pick<EntryRow, "message">>(
				`
			WITH recent AS (
				SELECT submission_seq, length(CAST(message AS BLOB)) AS bytes
				FROM effect_entries WHERE seq <= ? AND role IN ('user', 'assistant')
				ORDER BY seq DESC LIMIT ?
			), budget AS (
				SELECT submission_seq, SUM(SUM(bytes)) OVER (ORDER BY submission_seq DESC) AS bytes
				FROM recent GROUP BY submission_seq
			)
			SELECT message FROM effect_entries JOIN budget USING (submission_seq)
			WHERE budget.bytes <= ? AND role IN ('user', 'assistant')
			ORDER BY seq
		`,
				through,
				contextTurnLimit * 2,
				contextByteLimit,
			)
			.toArray()
			.map(({ message }) => Schema.decodeSync(contextJson)(message));
	}

	commit(runId: string, transcript: typeof TurnTranscript.Type) {
		const messages = transcript.messages.map((message) => ({
			role: message.role,
			json: Schema.encodeSync(messageJson)(message),
		}));
		return this.storage.transactionSync(() => {
			const row = this.#find(runId);
			if (row?.submission_id !== transcript.submissionId) {
				throw new Error("Transcript submission does not match its run.");
			}
			if (row.state === "completed") {
				return;
			}
			if (row.state !== "running") {
				throw new Error("The turn is not running.");
			}

			for (const message of messages) {
				this.storage.sql.exec(
					"INSERT INTO effect_entries (submission_seq, role, message) VALUES (?, ?, ?)",
					row.seq,
					message.role,
					message.json,
				);
			}
			this.storage.sql.exec(
				"UPDATE effect_submissions SET state = 'completed' WHERE seq = ?",
				row.seq,
			);
		});
	}

	fail(runId: string, error: string) {
		this.storage.sql.exec(
			`
			UPDATE effect_submissions SET state = 'failed', error = ?
			WHERE run_id = ? AND state IN ('pending', 'running')
		`,
			error,
			runId,
		);
	}

	state(runId: string) {
		return (
			this.storage.sql
				.exec<Pick<SubmissionRow, "state">>(
					"SELECT state FROM effect_submissions WHERE run_id = ?",
					runId,
				)
				.toArray()[0]?.state ?? "missing"
		);
	}

	turn(runId: string) {
		const row = this.#find(runId);
		let transcript: string | null = null;
		if (row?.state === "completed") {
			const messages = this.storage.sql
				.exec<Pick<EntryRow, "message">>(
					"SELECT message FROM effect_entries WHERE submission_seq = ? ORDER BY seq",
					row.seq,
				)
				.toArray()
				.map(({ message }) => Schema.decodeSync(messageJson)(message));
			transcript = Schema.encodeSync(transcriptJson)({ submissionId: row.submission_id, messages });
		}
		return { state: row?.state ?? "missing", error: row?.error ?? null, transcript };
	}

	history({ before, limit = 50 }: typeof HistoryQuery.Type) {
		const rows = this.storage.sql
			.exec<EntryRow>(
				`
			SELECT entries.seq, submissions.submission_id, entries.message
			FROM effect_entries AS entries JOIN effect_submissions AS submissions ON submissions.seq = entries.submission_seq
			WHERE entries.seq < ? ORDER BY entries.seq DESC LIMIT ?
		`,
				before ?? Number.MAX_SAFE_INTEGER,
				limit + 1,
			)
			.toArray();
		const entries = rows.slice(0, limit).reverse();
		return {
			entries: entries.map(({ seq, submission_id, message }) => ({
				id: seq,
				submissionId: submission_id,
				message,
			})),
			nextBefore: rows.length > limit ? entries[0].seq : null,
		};
	}

	#find(runId: string): SubmissionRow | undefined {
		return this.storage.sql
			.exec<SubmissionRow>("SELECT * FROM effect_submissions WHERE run_id = ?", runId)
			.toArray()[0];
	}
}
