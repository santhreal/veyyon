/** The one channel for "something is degraded and you need to know", when throwing is too much. two ways to raise a non-fatal problem, and neither reached a person: */

/** How much attention a notice deserves. Two levels, because a third is never used honestly. */
export type NoticeSeverity = "warning" | "error";

/** One thing the operator needs to know. */
export interface OperatorNotice {
	severity: NoticeSeverity;
	/** Which subsystem raised it, lowercase, one word where possible: `skills`, `secrets`. Rendered in front of the text so the operator knows what to go and fix, rather than */
	source: string;
	/** What is wrong and what to do about it. Never contains a credential. */
	text: string;
	/** Epoch milliseconds, so a surface that attaches late can still order them. */
	at: number;
}

/** Somewhere a notice can be shown. */
export type NoticeSink = (notice: OperatorNotice) => void;

/** One line, `source: text`, with the severity already implied by the surface rendering it. */
export function formatNotice(notice: OperatorNotice): string {
	return `${notice.source}: ${notice.text}`;
}

/** The last-resort sink: stderr, prefixed so it is recognisable in a captured log. */
export function stderrNoticeSink(notice: OperatorNotice): void {
	const label = notice.severity === "error" ? "error" : "warning";
	process.stderr.write(`${label}: ${formatNotice(notice)}\n`);
}

/** Collects notices and delivers them to whichever surface is available. Constructed by the caller that owns a surface (a mode) and handed to `createSession`, rather */
export class OperatorNotices {
	#sink: NoticeSink | undefined;
	readonly #pending: OperatorNotice[] = [];
	readonly #all: OperatorNotice[] = [];
	readonly #seen = new Set<string>();

	/** @param sink Where notices go. Omit to buffer until {@link setSink}, which is what a TUI wants: it cannot render anything until its screen exists. Pass */
	constructor(sink?: NoticeSink) {
		this.#sink = sink;
	}

	/** Raise a notice. IDENTICAL NOTICES COLLAPSE. The same problem is often detected once per turn (a pattern */
	add(notice: Omit<OperatorNotice, "at"> & { at?: number }): void {
		// The separator is written as an ESCAPE, not as a literal NUL byte. A raw control byte in source is invisible in every editor and diff, so the key
		const key = `${notice.severity}\0${notice.source}\0${notice.text}`;
		if (this.#seen.has(key)) return;
		this.#seen.add(key);

		const full: OperatorNotice = {
			severity: notice.severity,
			source: notice.source,
			text: notice.text,
			at: notice.at ?? Date.now(),
		};
		this.#all.push(full);
		if (this.#sink === undefined) {
			this.#pending.push(full);
			return;
		}
		this.#sink(full);
	}

	/** Convenience for the common case. */
	warn(source: string, text: string): void {
		this.add({ severity: "warning", source, text });
	}

	/** A problem that is not fatal but is worse than a warning: something is not working. */
	error(source: string, text: string): void {
		this.add({ severity: "error", source, text });
	}

	/** Attach a surface, delivering everything raised so far in the order it was raised. Replacing an existing sink does NOT redeliver: a notice already shown once is not shown */
	setSink(sink: NoticeSink): void {
		this.#sink = sink;
		const buffered = this.#pending.splice(0, this.#pending.length);
		for (const notice of buffered) sink(notice);
	}

	/** Notices raised but not yet delivered, oldest first. */
	pending(): readonly OperatorNotice[] {
		return this.#pending;
	}

	/** Everything raised in this session's lifetime, delivered or not. The record, so `/doctor`-style output and tests can read what happened without a surface */
	all(): readonly OperatorNotice[] {
		return this.#all;
	}

	/** Whether anything at all was raised. */
	get isEmpty(): boolean {
		return this.#all.length === 0;
	}
}
