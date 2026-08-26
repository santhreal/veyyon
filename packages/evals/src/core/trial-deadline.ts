/**
 * The deadline a trial runs under, and the bound on the output it keeps.
 *
 * Three backends each carried their own copy of these numbers, and the copies had drifted:
 * pier and harbor clamped at 3600 seconds, the in-process backend at 7200 under a different
 * name, and the raw-output cap existed three times over — twice measured in characters and
 * once in bytes. The override was read as `trialTimeoutSec` by one backend and by neither of
 * the others, so a config that set it changed nothing on a pier or harbor run and said so
 * nowhere. Both formulas also multiplied before clamping with no lower bound, so
 * `--timeout-multiplier 0.0001` produced `setTimeout(0)` and every trial "timed out after
 * 0s" the moment it started. In the other direction, a flat one-hour clamp cut a
 * Terminal-Bench task that states `[agent].timeout_sec = 18000` down to 3600 and reported the
 * kill as a timeout, so a stated budget now raises the ceiling for itself.
 *
 * This module is the one place any of it is decided.
 */

/** Used when a task states no budget of its own. */
export const DEFAULT_TRIAL_TIMEOUT_SEC = 1800;

/**
 * A trial whose budget is scaled, defaulted, or absent stops here. A task that states a longer
 * budget of its own is honored up to MAX_TRIAL_TIMEOUT_SEC: Terminal-Bench tasks declare
 * `[agent].timeout_sec` values of several hours, and clamping them to one hour killed a running
 * trial and reported it as a timeout the task never asked for.
 */
export const HARD_CEILING_TRIAL_TIMEOUT_SEC = 3600;

/** Nothing runs longer than a day, whatever a task budget or an override states. */
export const MAX_TRIAL_TIMEOUT_SEC = 86_400;

/** A deadline never rounds to zero, which would fire before the trial started. */
export const MIN_TRIAL_TIMEOUT_SEC = 1;

/** How long a terminated trial has to exit on SIGTERM before it is killed. */
export const DEFAULT_GRACE_PERIOD_MS = 5000;

/** The tail of a trial's raw output that is kept, measured in bytes. */
export const RAW_OUTPUT_MAX_BYTES = 65_536;

export interface TrialDeadlineInputs {
	/** The task's own budget. Zero, negative, or absent means the default applies. */
	readonly timeBudgetSec?: number | null;
	/** An explicit override of the task budget, in seconds. */
	readonly overrideSec?: number | null;
	/** Scales whatever budget applies. Absent or non-positive means 1. */
	readonly multiplier?: number | null;
}

function positiveOr(value: number | null | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The whole number of seconds a trial gets, clamped into the bounds above. */
export function resolveTrialTimeoutSec(inputs: TrialDeadlineInputs): number {
	const budget = positiveOr(inputs.overrideSec, positiveOr(inputs.timeBudgetSec, DEFAULT_TRIAL_TIMEOUT_SEC));
	const scaled = Math.round(budget * positiveOr(inputs.multiplier, 1));
	// A stated budget raises the ceiling for itself; a multiplier cannot push past it.
	const limit = Math.min(Math.max(HARD_CEILING_TRIAL_TIMEOUT_SEC, Math.round(budget)), MAX_TRIAL_TIMEOUT_SEC);
	return Math.min(Math.max(scaled, MIN_TRIAL_TIMEOUT_SEC), limit);
}

/**
 * The same answer from a run's loose options bag, so every backend reads one option name.
 * `trialTimeoutSec` overrides the task budget and `timeoutMultiplier` scales it.
 */
export function trialTimeoutFromOptions(
	timeBudgetSec: number | null | undefined,
	options?: Readonly<Record<string, unknown>>,
): number {
	const override = options?.trialTimeoutSec;
	const multiplier = options?.timeoutMultiplier;
	return resolveTrialTimeoutSec({
		timeBudgetSec,
		overrideSec: typeof override === "number" ? override : null,
		multiplier: typeof multiplier === "number" ? multiplier : null,
	});
}

/**
 * The last `maxBytes` bytes of a trial's output, or null when there is nothing to keep.
 * Measured in bytes rather than characters, so a run of multi-byte output is bounded by
 * what the journal actually writes.
 */
export function boundRawOutput(text: string | null | undefined, maxBytes = RAW_OUTPUT_MAX_BYTES): string | null {
	if (!text) return null;
	const buffer = Buffer.from(text, "utf-8");
	if (buffer.byteLength <= maxBytes) return text;
	// A cut inside a multi-byte sequence would leave a replacement character; decoding the
	// tail and dropping a leading partial character keeps the text valid.
	return buffer
		.subarray(buffer.byteLength - maxBytes)
		.toString("utf-8")
		.replace(/^\uFFFD/, "");
}
