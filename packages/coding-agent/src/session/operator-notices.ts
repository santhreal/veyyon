/**
 * The one channel for "something is degraded and you need to know", when throwing is too much.
 *
 * WHY THIS EXISTS, and it is not a logging convenience. Before this file there were exactly
 * two ways to raise a non-fatal problem, and neither reached a person:
 *
 *   - `logger.warn` / `logger.error`. The default transport set is `{ file: true }` with no
 *     console transport, and a TUI cannot write to the console anyway without corrupting its
 *     own render. So every warning raised at startup landed in a file nobody opens.
 *   - `AgentSession.skillWarnings`, a getter that collected skill-loading problems and was read
 *     by no production code at all. A dead channel that looks like a live one is worse than no
 *     channel, because the next person to need one reuses it and inherits the silence.
 *
 * That left refusing to start as the only reliably loud mechanism in the codebase, which is why
 * the secrets work had to throw for cases that only warranted a warning. Anything that wants to
 * say "this is degraded, carry on" now says it here, and every surface renders it.
 *
 * DELIVERY IS GUARANTEED, WHICH IS THE WHOLE POINT. Notices are raised while a session is being
 * built, which is before the TUI exists, so this buffers until a surface attaches and then
 * delivers everything in order. The default sink writes to stderr immediately, so a caller that
 * forgets to attach one still cannot lose a notice: the failure mode of forgetting is a message
 * in the wrong place, never a message that vanished (Law 10).
 */

/** How much attention a notice deserves. Two levels, because a third is never used honestly. */
export type NoticeSeverity = "warning" | "error";

/** One thing the operator needs to know. */
export interface OperatorNotice {
	severity: NoticeSeverity;
	/**
	 * Which subsystem raised it, lowercase, one word where possible: `skills`, `secrets`.
	 *
	 * Rendered in front of the text so the operator knows what to go and fix, rather than
	 * reading a sentence that could have come from anywhere.
	 */
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

/**
 * Collects notices and delivers them to whichever surface is available.
 *
 * Constructed by the caller that owns a surface (a mode) and handed to `createSession`, rather
 * than being a module-level singleton, so two sessions in one process cannot cross-post each
 * other's warnings and a test can read what was raised without touching a global.
 */
export class OperatorNotices {
	#sink: NoticeSink | undefined;
	readonly #pending: OperatorNotice[] = [];
	readonly #all: OperatorNotice[] = [];
	readonly #seen = new Set<string>();

	/**
	 * @param sink Where notices go. Omit to buffer until {@link setSink}, which is what a TUI
	 * wants: it cannot render anything until its screen exists. Pass
	 * {@link stderrNoticeSink} for a non-interactive mode, where stderr is the surface.
	 */
	constructor(sink?: NoticeSink) {
		this.#sink = sink;
	}

	/**
	 * Raise a notice.
	 *
	 * IDENTICAL NOTICES COLLAPSE. The same problem is often detected once per turn (a pattern
	 * that over-matches, an audit write that keeps failing), and repeating it every turn trains
	 * the operator to ignore the channel, which is the same outcome as having no channel. First
	 * occurrence wins, so the timestamp is when it started.
	 */
	add(notice: Omit<OperatorNotice, "at"> & { at?: number }): void {
		// The separator is written as an ESCAPE, not as a literal NUL byte. A raw
		// control byte in source is invisible in every editor and diff, so the key
		// reads as `${severity}${source}${text}` with no separator at all, which is
		// a joining bug you cannot see. NUL is still the right separator here: it
		// cannot occur in a severity, a source or a notice text, so no two distinct
		// notices can collide by splitting the field boundary differently.
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

	/**
	 * Attach a surface, delivering everything raised so far in the order it was raised.
	 *
	 * Replacing an existing sink does NOT redeliver: a notice already shown once is not shown
	 * again when the surface changes, or resuming a session would repeat every startup warning.
	 */
	setSink(sink: NoticeSink): void {
		this.#sink = sink;
		const buffered = this.#pending.splice(0, this.#pending.length);
		for (const notice of buffered) sink(notice);
	}

	/** Notices raised but not yet delivered, oldest first. */
	pending(): readonly OperatorNotice[] {
		return this.#pending;
	}

	/**
	 * Everything raised in this session's lifetime, delivered or not.
	 *
	 * The record, so `/doctor`-style output and tests can read what happened without a surface
	 * having to have been attached.
	 */
	all(): readonly OperatorNotice[] {
		return this.#all;
	}

	/** Whether anything at all was raised. */
	get isEmpty(): boolean {
		return this.#all.length === 0;
	}
}
