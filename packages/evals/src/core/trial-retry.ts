/**
 * How many times one trial is attempted, and which failures earn another attempt.
 *
 * A trial that threw produced no artifacts at all: the container never started, the gateway
 * refused, the provider answered 503, a socket closed mid-stream. Nothing about the task was
 * measured, so the row carried an infrastructure error and the task was lost for the whole run —
 * on a 500-trial run a one-percent flake rate silently removed five tasks from the comparison,
 * and the only recovery was a second run of everything.
 *
 * A graded outcome is never retried. A trial that ran and failed its verifier is a result, and a
 * trial that ran past its deadline spent its whole budget: attempting either again would pay twice
 * for an answer already in hand and would bias the arm toward whichever attempt read better.
 */

/** Attempts per trial when nothing states otherwise: the first one, plus one retry of a throw. */
export const DEFAULT_TRIAL_ATTEMPTS = 2;

/** No trial is attempted more than this, whatever a config or a flag states. */
export const MAX_TRIAL_ATTEMPTS = 5;

/** Delay before the first retry. Each further attempt doubles it, up to the cap below. */
export const TRIAL_RETRY_BASE_DELAY_MS = 2000;

/** A retry never waits longer than this, so a long run cannot stall on backoff. */
export const TRIAL_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Attempts allowed for one trial, from a run's loose options bag. `trialAttempts` is the name every
 * backend and entry point uses; a value below 1 or above the cap is clamped rather than refused,
 * because a run that already staged its assets should not die over a retry count.
 */
export function resolveTrialAttempts(options?: Readonly<Record<string, unknown>>): number {
	const stated = options?.trialAttempts;
	if (typeof stated !== "number" || !Number.isFinite(stated)) return DEFAULT_TRIAL_ATTEMPTS;
	return Math.min(Math.max(Math.trunc(stated), 1), MAX_TRIAL_ATTEMPTS);
}

/** Backoff before attempt `attempt` (2 for the first retry), bounded by the cap above. */
export function trialRetryDelayMs(attempt: number): number {
	const step = Math.max(1, Math.trunc(attempt) - 1);
	return Math.min(TRIAL_RETRY_BASE_DELAY_MS * 2 ** (step - 1), TRIAL_RETRY_MAX_DELAY_MS);
}

/**
 * Whether a thrown trial failure earns another attempt.
 *
 * Everything a backend throws is infrastructure: a graded outcome comes back as a score, not as an
 * exception. The two exceptions are a cancelled run, where a retry would fight the operator, and a
 * trial killed by its own deadline, where the budget is already spent.
 */
export function isRetryableTrialFailure(cause: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;
	const message = cause instanceof Error ? cause.message : String(cause);
	if (/\babort(ed)?\b/i.test(message)) return false;
	return !/\b(timed out|timeout|exceeded deadline|deadline)\b/i.test(message);
}
