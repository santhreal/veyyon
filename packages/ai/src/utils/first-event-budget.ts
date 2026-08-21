/**
 * The declared pre-first-event budget, as an object a retry ladder can consult.
 *
 * `StreamOptions.streamFirstEventTimeoutMs` says how long a caller will wait for
 * the first event of a turn. Every provider already applies it to ONE attempt:
 * a pre-response fence around the request, and a timer around the wait for the
 * first semantic event. Nothing applied it to the SEQUENCE of attempts, so a
 * provider that treats "no response at all" as retryable spent the whole budget
 * again on every attempt, plus backoff between them. With the shipped defaults
 * that turns a 100s declared budget into roughly seven minutes of silence
 * against a dead endpoint — the provider was behaving exactly as written, and
 * the caller's number meant nothing.
 *
 * A budget object fixes that without giving any provider a second opinion about
 * time: the ladder asks `spent()` before retrying a stall, and asks `fence()`
 * for a deadline that covers a whole setup phase rather than one request in it.
 *
 * SCOPE. This bounds the phase BEFORE the first event, and only for failures
 * where no response ever arrived ({@link isPreResponseStall}). A server that
 * answers — a 429 with `retry-after`, a 503, an envelope error mid-stream — is
 * not a stall and keeps its own retry budget: the server said "come back", and
 * honoring that is what makes rate limits survivable. Once the first event
 * arrives, `streamIdleTimeoutMs` owns the rest of the turn.
 */

import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";

/**
 * Errors that mean the transport never produced a response: a pre-response
 * fence firing, a request timeout, a first-event watchdog. Deliberately narrow
 * — a caller abort is not a stall, and a failure carrying a server status is
 * not one either, because the server answered.
 */
const PRE_RESPONSE_STALL_PATTERN = /\btimed?\s*out\b|\btimeout\b|\bstream stall\b/i;

/** True when `error` means no byte of a response ever arrived. */
export function isPreResponseStall(error: unknown): boolean {
	if (error instanceof Error) {
		if (error.name === "TimeoutError" || error.name === "AnthropicConnectionTimeoutError") return true;
		return PRE_RESPONSE_STALL_PATTERN.test(error.message);
	}
	// A DOMException in a runtime where it does not extend Error still carries a name.
	const name = (error as { name?: unknown } | null)?.name;
	return name === "TimeoutError";
}

/**
 * A deadline handle: the signal to pass down, and the `cancel()` that clears
 * its backing timer. `signal` is `undefined` only when the budget is unbounded
 * and the caller passed no signal of its own — there is nothing to wait on.
 */
export interface BudgetFence {
	signal: AbortSignal | undefined;
	cancel(): void;
}

/** The budget a caller declared for reaching the first event of one turn. */
export interface FirstEventBudget {
	/** Total milliseconds allowed, or `undefined` when the caller declared none. */
	readonly totalMs: number | undefined;
	/** Milliseconds still available, `0` once spent, `undefined` when unbounded. */
	remainingMs(): number | undefined;
	/** True when another attempt cannot fit inside the declared budget. */
	spent(): boolean;
	/**
	 * A deadline covering the remaining budget, composed with `callerSignal`.
	 * The caller MUST `cancel()` in `finally` so the backing timer never
	 * outlives the phase.
	 */
	fence(callerSignal?: AbortSignal): BudgetFence;
}

/**
 * Open a budget of `totalMs`, starting now. A non-positive or absent total is
 * unbounded, which is what `streamFirstEventTimeoutMs: 0` already means
 * everywhere else: the caller turned the watchdog off.
 */
export function openFirstEventBudget(totalMs: number | undefined, now: () => number = Date.now): FirstEventBudget {
	const total = totalMs !== undefined && totalMs > 0 ? totalMs : undefined;
	const startedAt = now();
	const remainingMs = (): number | undefined => {
		if (total === undefined) return undefined;
		return Math.max(0, total - (now() - startedAt));
	};
	return {
		totalMs: total,
		remainingMs,
		spent: () => remainingMs() === 0,
		fence: callerSignal => {
			const remaining = remainingMs();
			if (remaining === undefined) return { signal: callerSignal, cancel: () => {} };
			// An exhausted budget still hands back an armed signal: 1ms rather
			// than 0 keeps the abort asynchronous, so a caller that fences and
			// then awaits sees the rejection instead of a synchronous throw from
			// inside its own setup.
			return scopedTimeoutSignal(Math.max(1, remaining), callerSignal);
		},
	};
}

/**
 * The budget for a phase that has its own ceiling: the smaller of what the
 * caller declared and what the provider allows itself. Never looser than
 * either, which is what makes adopting it a strict tightening.
 */
export function openBoundedFirstEventBudget(
	declaredMs: number | undefined,
	ceilingMs: number,
	now: () => number = Date.now,
): FirstEventBudget {
	const declared = declaredMs !== undefined && declaredMs > 0 ? declaredMs : undefined;
	return openFirstEventBudget(declared === undefined ? ceilingMs : Math.min(declared, ceilingMs), now);
}
