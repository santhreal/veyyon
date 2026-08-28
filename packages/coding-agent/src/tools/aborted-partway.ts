import { ToolAbortError } from "./tool-errors";

/** The one owner of the sentence a tool throws when a cancellation lands mid-sequence. multi-file `edit`, a multi-PR `pr_checkout`, and a multi-item `retain`. Each has to say the */
export interface AbortedPartway {
	/** Names the operation, as the subject of the sentence: `Edit`, `PR checkout`, `Retain`. */
	operation: string;
	/** The unit being counted, singular and plural, both spelled out. Spelled rather than suffixed because `entry` + "s" is `entrys`, and a message that exists */
	unit: { one: string; many: string };
	/** What finished, each entry described the way the reader needs to find it again. */
	done: readonly string[];
	/** What was not reached. */
	pending: readonly string[];
	/** Label for the finished clause: `already applied`, `already checked out`. */
	doneLabel: string;
	/** Label for the unreached clause, capitalised as a warning: `NOT applied`. */
	pendingLabel: string;
	/** The closing clause, when there is something the reader should do or know. Omitted entirely rather than defaulted: advice that does not fit the operation is worse */
	advice?: string;
	/** Advice that applies only when something DID finish (e.g. what was left behind). */
	adviceWhenDone?: string;
}

/** Build the {@link ToolAbortError} for a sequence cancelled partway through. The result is an ABORT rather than a tool error on purpose, and that distinction is the */
export function abortedPartway(parts: AbortedPartway, cause: unknown): ToolAbortError {
	const total = parts.done.length + parts.pending.length;
	const unit = total === 1 ? parts.unit.one : parts.unit.many;
	const clauses = [`${parts.operation} cancelled after ${parts.done.length} of ${total} ${unit}`];
	if (parts.done.length > 0) clauses.push(`${parts.doneLabel}: ${parts.done.join(", ")}`);
	if (parts.pending.length > 0) clauses.push(`${parts.pendingLabel}: ${parts.pending.join(", ")}`);
	if (parts.done.length > 0 && parts.adviceWhenDone) clauses.push(parts.adviceWhenDone);
	if (parts.advice) clauses.push(parts.advice);
	return new ToolAbortError(clauses.join("; "), { cause });
}
