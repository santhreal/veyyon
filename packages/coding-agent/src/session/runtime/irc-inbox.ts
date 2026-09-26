/**
 * The IRC records that reached a session while it could not take them at once, until a step boundary,
 * an inbox call or the next prompt takes them.
 *
 * This is a session collaborator. It holds two queues and never touches the session: the session
 * queues each record, and takes them back at the boundary that delivers them.
 *
 * - **Interrupts**: a peer message that arrived mid-turn. `job poll` and `irc wait` peek at these
 *   through {@link IrcInbox.hasInterrupts} to return before the next step boundary.
 * - **Asides**: an auto-reply this session sent on its own behalf, recorded so the model knows what
 *   was said for it.
 *
 * Every take returns interrupts before asides.
 */
import type { IrcMessage } from "../../task/irc-bus";
import type { CustomMessage } from "../messages";

/** Which `irc:incoming` records {@link IrcInbox.takeIncoming} returns. */
export interface IrcIncomingFilter {
	/** Only records sent by this agent. */
	from?: string;
	/** At most this many records. */
	limit?: number;
}

export class IrcInbox {
	#interrupts: CustomMessage[] = [];
	#asides: CustomMessage[] = [];

	/** Whether a peer message is waiting for the next step boundary. */
	get hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether any record is waiting. */
	get isEmpty(): boolean {
		return this.#interrupts.length === 0 && this.#asides.length === 0;
	}

	queueInterrupt(record: CustomMessage): void {
		this.#interrupts.push(record);
	}

	queueAside(record: CustomMessage): void {
		this.#asides.push(record);
	}

	/** Every waiting record, interrupts first, leaving both queues empty. */
	takeAll(): CustomMessage[] {
		const records = this.#interrupts.concat(this.#asides);
		this.#interrupts = [];
		this.#asides = [];
		return records;
	}

	/**
	 * The waiting `irc:incoming` records that match `filter`, as bus messages addressed to `agentId`,
	 * removed from their queues. Every other record stays where it was, in order.
	 */
	takeIncoming(agentId: string, filter?: IrcIncomingFilter): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const keep = (record: CustomMessage): boolean => {
			if (record.customType !== "irc:incoming") return true;
			const details = record.details;
			if (!details || typeof details !== "object") return true;
			const id = Reflect.get(details, "id");
			const from = Reflect.get(details, "from");
			const body = Reflect.get(details, "message");
			const replyTo = Reflect.get(details, "replyTo");
			if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") return true;
			if (filter?.from !== undefined && from !== filter.from) return true;
			if (filter?.limit !== undefined && messages.length >= filter.limit) return true;
			messages.push({
				id,
				from,
				to: agentId,
				body,
				ts: record.timestamp,
				...(typeof replyTo === "string" ? { replyTo } : {}),
			});
			return false;
		};
		this.#interrupts = this.#interrupts.filter(keep);
		this.#asides = this.#asides.filter(keep);
		return messages;
	}
}
