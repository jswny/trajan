import {
	ConversationMessage,
	SavedModelContext,
	TurnMessage,
	TurnTranscript,
} from "@trajan/harness";
import type { RuntimeOutcome, TurnCompletion, TurnSubmission } from "@trajan/harness";
import { Option, Schema } from "effect";

const contextTurnLimit = 16;
const contextByteLimit = 32_000;
const messageJson = Schema.fromJsonString(TurnMessage);
const contextJson = Schema.fromJsonString(ConversationMessage);
const transcriptJson = Schema.fromJsonString(TurnTranscript);
const modelContextKey = "harness-model-context";
const modelOutcomesCursorKey = "harness-model-outcomes-through";
const outcomesLimit = 12;
const decodeModelContext = Schema.decodeUnknownOption(SavedModelContext);
const decodeOutcomesCursor = Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.Natural));

export type HistoryQuery = {
	readonly before?: number;
	readonly limit?: number;
};

const AdmissionRow = Schema.Struct({
	run_id: Schema.NonEmptyString,
	prompt: Schema.NonEmptyString,
});
const SubmissionRow = Schema.Struct({
	...AdmissionRow.fields,
	seq: Schema.Int.check(Schema.isGreaterThan(0)),
	submission_id: Schema.NonEmptyString,
	state: Schema.Literals(["pending", "running", "stopping", "completed", "failed", "cancelled"]),
	context_through: Schema.NullOr(Schema.Natural),
	error: Schema.NullOr(Schema.String),
});
const MessageRow = Schema.Struct({ message: Schema.String });
const EntryRow = Schema.Struct({
	...MessageRow.fields,
	seq: SubmissionRow.fields.seq,
	submission_id: SubmissionRow.fields.submission_id,
});
const decodeAdmission = Schema.decodeUnknownSync(Schema.UndefinedOr(AdmissionRow));
const decodeSubmission = Schema.decodeUnknownSync(SubmissionRow);
const decodeOptionalSubmission = Schema.decodeUnknownSync(Schema.UndefinedOr(SubmissionRow));
const decodeMessage = Schema.decodeUnknownSync(MessageRow);
const decodeEntry = Schema.decodeUnknownSync(EntryRow);
const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Natural }));
const decodeOutcomeRow = Schema.decodeUnknownSync(
	Schema.Struct({
		...MessageRow.fields,
		prompt: Schema.String,
		seq: SubmissionRow.fields.seq,
		submission_seq: SubmissionRow.fields.seq,
	}),
);

export class ConversationStore {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly settleRunState: (
			runId: string,
			outcome: "completed" | "failed" | "cancelled",
		) => ReadonlyArray<typeof TurnMessage.Type> | undefined,
	) {}

	initialize() {
		this.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS harness_submissions (
				seq INTEGER PRIMARY KEY,
				run_id TEXT UNIQUE NOT NULL,
				submission_id TEXT UNIQUE NOT NULL,
				prompt TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'pending',
				context_through INTEGER,
				error TEXT
			);
			CREATE INDEX IF NOT EXISTS harness_submissions_pending
				ON harness_submissions(seq) WHERE state IN ('pending', 'running', 'stopping');
			CREATE TABLE IF NOT EXISTS harness_entries (
				seq INTEGER PRIMARY KEY,
				submission_seq INTEGER NOT NULL REFERENCES harness_submissions(seq),
				role TEXT NOT NULL,
				message TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS harness_entries_submission ON harness_entries(submission_seq, seq);
			CREATE INDEX IF NOT EXISTS harness_entries_context ON harness_entries(seq)
				WHERE role IN ('user', 'assistant');
		`);
	}

	admit(submission: typeof TurnSubmission.Type) {
		return this.storage.transactionSync(() => {
			const existing = decodeAdmission(
				this.storage.sql
					.exec(
						"SELECT run_id, prompt FROM harness_submissions WHERE submission_id = ?",
						submission.id,
					)
					.toArray()[0],
			);
			if (existing) {
				return existing.prompt === submission.prompt
					? { runId: existing.run_id, accepted: false }
					: {
							runId: null,
							accepted: false as const,
							error: "That submission ID already belongs to a different prompt.",
						};
			}

			const runId = crypto.randomUUID();
			this.storage.sql.exec(
				"INSERT INTO harness_submissions (run_id, submission_id, prompt) VALUES (?, ?, ?)",
				runId,
				submission.id,
				submission.prompt,
			);
			return { runId, accepted: true };
		});
	}

	recordUnadmittedSubmission(submission: typeof TurnSubmission.Type, text: string) {
		return this.storage.transactionSync(() => {
			const [row] = this.storage.sql
				.exec(
					`INSERT INTO harness_submissions (run_id, submission_id, prompt, state, error)
				 VALUES (?, ?, ?, 'failed', ?) ON CONFLICT(submission_id) DO NOTHING RETURNING seq`,
					`missed:${submission.id}`,
					submission.id,
					submission.prompt,
					text,
				)
				.toArray();
			if (!row) {
				return false;
			}
			this.storage.sql.exec(
				"INSERT INTO harness_entries (submission_seq, role, message) VALUES (?, 'notice', ?)",
				Schema.decodeUnknownSync(SubmissionRow.fields.seq)(row.seq),
				Schema.encodeSync(messageJson)({ role: "notice", status: "failed", text }),
			);
			return true;
		});
	}

	head() {
		return decodeOptionalSubmission(
			this.storage.sql
				.exec(`
			SELECT * FROM harness_submissions WHERE state IN ('pending', 'running', 'stopping') ORDER BY seq LIMIT 1
		`)
				.toArray()[0],
		);
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
			return decodeSubmission(
				this.storage.sql
					.exec(
						`
				UPDATE harness_submissions SET state = 'running',
					context_through = (SELECT COALESCE(MAX(seq), 0) FROM harness_entries)
				WHERE run_id = ? RETURNING *
			`,
						runId,
					)
					.one(),
			);
		});
	}

	context(through: number) {
		// Count whole exchanges before loading message bodies into the Worker.
		return this.storage.sql
			.exec(
				`
			WITH recent AS (
				SELECT submission_seq, length(CAST(message AS BLOB)) AS bytes
				FROM harness_entries JOIN harness_submissions ON harness_submissions.seq = submission_seq
				WHERE harness_entries.seq <= ? AND role IN ('user', 'assistant')
					AND harness_submissions.state = 'completed'
				ORDER BY harness_entries.seq DESC LIMIT ?
			), budget AS (
				SELECT submission_seq, SUM(SUM(bytes)) OVER (ORDER BY submission_seq DESC) AS bytes
				FROM recent GROUP BY submission_seq
			)
			SELECT message FROM harness_entries JOIN budget USING (submission_seq)
			WHERE budget.bytes <= ? AND role IN ('user', 'assistant')
			ORDER BY seq
		`,
				through,
				contextTurnLimit * 2,
				contextByteLimit,
			)
			.toArray()
			.map((row) => Schema.decodeSync(contextJson)(decodeMessage(row).message));
	}

	modelContext() {
		return Option.getOrUndefined(decodeModelContext(this.storage.kv.get(modelContextKey)));
	}

	runtimeOutcomes(through: number) {
		const delivered = decodeOutcomesCursor(this.storage.kv.get(modelOutcomesCursorKey)) ?? 0;
		const rows = this.storage.sql
			.exec(
				`SELECT harness_entries.seq, message, prompt, submission_seq FROM harness_entries
			 JOIN harness_submissions ON harness_submissions.seq = submission_seq
			 WHERE role = 'notice' AND harness_entries.seq > ? AND harness_entries.seq <= ? ORDER BY harness_entries.seq LIMIT ?`,
				delivered,
				through,
				outcomesLimit,
			)
			.toArray()
			.map((row) => decodeOutcomeRow(row));
		return {
			through: rows.length === outcomesLimit ? rows[outcomesLimit - 1].seq : through,
			messages: rows.flatMap((row) => {
				const message = Schema.decodeSync(messageJson)(row.message);
				if (message.role !== "notice") {
					return [];
				}
				const tools = this.storage.sql
					.exec(
						"SELECT message FROM harness_entries WHERE submission_seq = ? AND role = 'tool' ORDER BY seq",
						row.submission_seq,
					)
					.toArray()
					.flatMap((raw) => {
						const entry = Schema.decodeSync(messageJson)(decodeMessage(raw).message);
						return entry.role === "tool"
							? (entry.result.activity ?? []).map(({ name, status, fileChange }) => ({
									name,
									status,
									...(fileChange && { path: fileChange.path.slice(0, 256) }),
								}))
							: [];
					})
					.slice(-12);
				return [
					{
						role: "runtime-outcome",
						status: message.status,
						text: message.text.slice(0, 512),
						request: row.prompt.slice(0, 512),
						tools,
					} satisfies typeof RuntimeOutcome.Type,
				];
			}),
		};
	}

	commit(runId: string, transcript: TurnCompletion, outcomesThrough: number) {
		const messages = transcript.messages.map((message) => ({
			role: message.role,
			json: Schema.encodeSync(messageJson)(message),
		}));
		return this.storage.transactionSync(() => {
			const row = this.#find(runId);
			if (row?.submission_id !== transcript.submissionId) {
				throw new Error("Transcript submission does not match its run.");
			}
			if (row.state === "completed" || row.state === "stopping") {
				return;
			}
			if (row.state !== "running") {
				throw new Error("The turn is not running.");
			}

			for (const message of messages) {
				this.storage.sql.exec(
					"INSERT INTO harness_entries (submission_seq, role, message) VALUES (?, ?, ?)",
					row.seq,
					message.role,
					message.json,
				);
			}
			this.storage.sql.exec(
				"UPDATE harness_submissions SET state = 'completed' WHERE seq = ?",
				row.seq,
			);
			if (transcript.modelContext !== undefined) {
				this.storage.kv.put(modelContextKey, transcript.modelContext);
			} else {
				this.storage.kv.delete(modelContextKey);
			}
			this.storage.kv.put(modelOutcomesCursorKey, outcomesThrough);
			this.settleRunState(runId, "completed");
		});
	}

	fail(runId: string, error: string) {
		this.#end(runId, "failed", error || "The turn failed.");
	}

	requestStop(runId: string) {
		return this.storage.transactionSync(() => {
			const row = this.head();
			if (row?.run_id !== runId) {
				return false;
			}
			this.storage.sql.exec(
				"UPDATE harness_submissions SET state = 'stopping' WHERE run_id = ?",
				runId,
			);
			return true;
		});
	}

	cancel(runId: string) {
		this.#end(runId, "cancelled", "Stopped");
	}

	#end(runId: string, status: "failed" | "cancelled", text: string) {
		this.storage.transactionSync(() => {
			const row = this.#find(runId);
			if (
				!row ||
				(status === "cancelled"
					? row.state !== "stopping"
					: row.state !== "pending" && row.state !== "running")
			) {
				return;
			}
			this.storage.sql.exec(
				"UPDATE harness_submissions SET state = ?, error = ? WHERE seq = ?",
				status,
				status === "failed" ? text : null,
				row.seq,
			);
			const messages: ReadonlyArray<typeof TurnMessage.Type> = [
				{ role: "user", text: row.prompt },
				...(this.settleRunState(runId, status) ?? []),
				{ role: "notice", status, text },
			];
			for (const message of messages) {
				this.storage.sql.exec(
					"INSERT INTO harness_entries (submission_seq, role, message) VALUES (?, ?, ?)",
					row.seq,
					message.role,
					Schema.encodeSync(messageJson)(message),
				);
			}
		});
	}

	status() {
		const head = this.head();
		const active =
			head && (head.state === "pending" || head.state === "running" || head.state === "stopping")
				? {
						runId: head.run_id,
						submissionId: head.submission_id,
						prompt: head.prompt,
						state: head.state,
					}
				: null;
		const { count: queued } = decodeCount(
			this.storage.sql
				.exec("SELECT COUNT(*) AS count FROM harness_submissions WHERE state = 'pending'")
				.one(),
		);
		return {
			active,
			queued: queued - Number(active?.state === "pending"),
		};
	}

	page(query: HistoryQuery) {
		const { entries, nextBefore } = this.history(query);
		return {
			entries: entries.map((entry) => ({
				...entry,
				message: Schema.decodeSync(messageJson)(entry.message),
			})),
			nextBefore,
		};
	}

	turn(runId: string) {
		const row = this.#find(runId);
		let transcript: string | null = null;
		if (row?.state === "completed") {
			const messages = this.storage.sql
				.exec("SELECT message FROM harness_entries WHERE submission_seq = ? ORDER BY seq", row.seq)
				.toArray()
				.map((row) => Schema.decodeSync(messageJson)(decodeMessage(row).message));
			transcript = Schema.encodeSync(transcriptJson)({ submissionId: row.submission_id, messages });
		}
		return { state: row?.state ?? "missing", error: row?.error ?? null, transcript };
	}

	history({ before, limit = 50 }: HistoryQuery) {
		const rows = this.storage.sql
			.exec(
				`
			SELECT entries.seq, submissions.submission_id, entries.message
			FROM harness_entries AS entries JOIN harness_submissions AS submissions ON submissions.seq = entries.submission_seq
			WHERE entries.seq < ? ORDER BY entries.seq DESC LIMIT ?
		`,
				before ?? Number.MAX_SAFE_INTEGER,
				limit + 1,
			)
			.toArray()
			.map((row) => decodeEntry(row));
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

	#find(runId: string) {
		return decodeOptionalSubmission(
			this.storage.sql
				.exec("SELECT * FROM harness_submissions WHERE run_id = ?", runId)
				.toArray()[0],
		);
	}
}
