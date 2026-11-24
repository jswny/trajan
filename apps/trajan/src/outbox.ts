import type { UserInput } from "@earendil-works/pi-durable";
import type { PiWhenBusy } from "agents/harness/pi";
import { isSubmitReceipt } from "./protocol";
import type { PiClientMessage, PiServerMessage } from "./protocol";

/** A submit as the outbox sends it: always named, by id and operation id. */
export type PiOutboxSubmit = Extract<PiClientMessage, { type: "submit" }> & {
	readonly id: string;
	readonly operationId: string;
};

/**
 * Submits the client has sent but not seen answered, in memory.
 *
 * A connection can drop after the server admitted a prompt but before the
 * client read its result. Each submit carries an `operationId` equal to its
 * message id, which the harness deduplicates on, so sending it again returns
 * the same operation (`accepted: false`) instead of running the prompt
 * twice. The client keeps a submit here until a matching receipt or error
 * arrives, so reconnect and receipt recovery can send the same command.
 */
export class PiCommandOutbox {
	readonly #pending = new Map<string, PiOutboxSubmit>();

	/** A new submit, kept until it is answered. */
	submit(input: UserInput, whenBusy?: PiWhenBusy): PiOutboxSubmit {
		const id = crypto.randomUUID();
		const command: PiOutboxSubmit = {
			type: "submit",
			id,
			operationId: id,
			input,
			...(whenBusy !== undefined && { whenBusy }),
		};
		this.#pending.set(id, command);
		return command;
	}

	/** Unanswered submits, oldest first. */
	pending(): Array<PiOutboxSubmit> {
		return [...this.#pending.values()];
	}

	/** Forget every unanswered submit. */
	clear(): void {
		this.#pending.clear();
	}

	/** Whether this reply settled a pending submit. */
	receive(message: PiServerMessage): boolean {
		if (message.type !== "result" && message.type !== "error") {
			return false;
		}
		if (message.id === undefined) {
			return false;
		}
		const pending = this.#pending.get(message.id);
		if (!pending) {
			return false;
		}
		if (
			message.type === "result" &&
			(!isSubmitReceipt(message.result) || message.result.operationId !== pending.operationId)
		) {
			return false;
		}
		return this.#pending.delete(message.id);
	}
}
