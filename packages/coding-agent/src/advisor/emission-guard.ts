/** Per-session policy gate for advisor `advise()` calls. The advisor system prompt tells the watcher model: */

/** Case-insensitive, punctuation-folded normalization. Collapses every run of non-letter / non-digit characters into a single space and trims, so */

import { NON_ALNUM_RUN_RE } from "@veyyon/utils";

export function normalizeAdvisorNote(note: string): string {
	return note.toLowerCase().normalize("NFKC").replace(NON_ALNUM_RUN_RE, " ").trim();
}

/** Normalized phrases the advisor occasionally emits that carry no concrete actionable content. Each must be the output of {@link normalizeAdvisorNote} */
const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
	// Self-stop noise — telling the agent to "stop" without a reason is useless.
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,
	// Completion self-talk — the agent already finished the task.
	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,
	// "Nothing to flag" — silence is the correct expression of "no concerns".
	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,
	// Endorsements — equivalent to silence.
	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

/** Bounds the dedupe history. Sessions with very long advisor activity could otherwise grow the set without bound. The reporter's pathological session */
const DEFAULT_HISTORY_CAPACITY = 4096;

/** Decides whether an advisor `advise()` call should reach the primary agent. Enforces — in this order — the noise filter, session-scoped exact-text */
export class AdvisorEmissionGuard {
	#seen = new Set<string>();
	/** Insertion-order log to drive FIFO eviction without an extra Map. */
	#seenOrder: string[] = [];
	#consumedThisUpdate = false;
	readonly #capacity: number;

	constructor(opts: { capacity?: number } = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
	}

	/** Drop all dedupe and per-update state. Called from `AgentSession#resetAdvisorSessionState()` whenever the advisor runtime is */
	reset(): void {
		this.#seen.clear();
		this.#seenOrder.length = 0;
		this.#consumedThisUpdate = false;
	}

	/** Clear the per-update rate-limit gate. Called by `AdvisorRuntime` right before each `agent.prompt(batch)` invocation so the next advisor model */
	beginUpdate(): void {
		this.#consumedThisUpdate = false;
	}

	/** Whether the proposed note should reach the primary. On `true` the gate has already recorded the note (consumed the per-update budget and added */
	accept(note: string): boolean {
		const key = normalizeAdvisorNote(note);
		if (!key) return false;
		// Object.hasOwn, not `SUPPRESSED_NORMALIZED_PHRASES[key]`: a bare index read resolves Object.prototype members, so a note normalizing to `constructor`
		if (Object.hasOwn(SUPPRESSED_NORMALIZED_PHRASES, key)) return false;
		if (this.#seen.has(key)) return false;
		if (this.#consumedThisUpdate) return false;
		this.#consumedThisUpdate = true;
		this.#seen.add(key);
		this.#seenOrder.push(key);
		if (this.#seenOrder.length > this.#capacity) {
			const stale = this.#seenOrder.shift();
			if (stale !== undefined) this.#seen.delete(stale);
		}
		return true;
	}
}
