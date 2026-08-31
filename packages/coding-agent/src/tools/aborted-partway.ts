import { ToolAbortError } from "./tool-errors";

/**
 * The one owner of the sentence a tool throws when a cancellation lands mid-sequence.
 *
 * WHY THIS IS SHARED. Three tools do work in steps and can be cancelled between them: a
 * multi-file `edit`, a multi-PR `pr_checkout`, and a multi-item `retain`. Each has to say the
 * same four things -- how far it got, what is already done, what was not reached, and what the
 * reader should do about it -- and each was written out by hand. The shape drifted on the first
 * try: the edit version shipped `1 of 3 entrys`, because a plural was built by suffixing "s".
 *
 * The parts that VARY are the nouns and the advice, and those belong to the caller: only the
 * edit tool can say "re-read the affected files", only `pr_checkout` can say the worktrees are
 * still on disk. The part that is SHARED is the sentence: the order of the clauses, the
 * separator, the count, and which clauses are omitted when they would be empty.
 *
 * An earlier pass hoisted a helper for this and moved it back, correctly at the time, because
 * eval turned out to have no sequence to interrupt and the helper was left with one caller. It
 * has three now, which is the point at which the shape is worth owning rather than repeating.
 */
export interface AbortedPartway {
	/** Names the operation, as the subject of the sentence: `Edit`, `PR checkout`, `Retain`. */
	operation: string;
	/**
	 * The unit being counted, singular and plural, both spelled out.
	 *
	 * Spelled rather than suffixed because `entry` + "s" is `entrys`, and a message that exists
	 * to be read at the worst moment of a session cannot be where a reader trips over a typo.
	 */
	unit: { one: string; many: string };
	/** What finished, each entry described the way the reader needs to find it again. */
	done: readonly string[];
	/** What was not reached. */
	pending: readonly string[];
	/** Label for the finished clause: `already applied`, `already checked out`. */
	doneLabel: string;
	/** Label for the unreached clause, capitalised as a warning: `NOT applied`. */
	pendingLabel: string;
	/**
	 * The closing clause, when there is something the reader should do or know.
	 *
	 * Omitted entirely rather than defaulted: advice that does not fit the operation is worse
	 * than none, and a generic "try again" would be wrong for every one of the three callers.
	 */
	advice?: string;
	/** Advice that applies only when something DID finish (e.g. what was left behind). */
	adviceWhenDone?: string;
}

/**
 * Build the {@link ToolAbortError} for a sequence cancelled partway through.
 *
 * The result is an ABORT rather than a tool error on purpose, and that distinction is the
 * reason this function exists at all: the agent loop's correct response to a failure is to
 * read it and retry, and its correct response to a cancellation is to stop. Tools that folded
 * a cancellation into an ordinary `isError` result made the two indistinguishable, so an
 * Escape was answered by a retry of the very work the operator had just stopped.
 */
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
