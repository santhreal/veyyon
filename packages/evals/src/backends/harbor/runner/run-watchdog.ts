/**
 * The ceiling on one harbor invocation.
 *
 * The runner rendered a progress screen in `while (!finished)` and slept, with nothing else able to
 * end the loop. A harbor that never exits — a container wedged on a pull, a compose project waiting
 * on a lock — left the run rendering forever, its manager row stuck at running, and the operator
 * with no way to tell a slow run from a dead one.
 *
 * The ceiling is every expected trial's own budget taken serially plus a grace. Harbor runs trials
 * concurrently, so a legitimate run cannot reach it; a run that does has stopped making progress.
 */

import { resolveTrialTimeoutSec } from "../../../core/trial-deadline";

/** Slack for the pulls, builds and verifier passes that sit outside a trial's own budget. */
export const RUN_WATCHDOG_GRACE_SEC = 600;

/** What a run that outlasted its ceiling exits with, following the shell convention for a timeout. */
export const RUN_CEILING_EXIT_CODE = 124;

export type HarborRunOutcome = "finished" | "ceiling";

export interface HarborRunWaitOptions {
	/** True once the harbor child has exited. */
	readonly finished: () => boolean;
	/** Milliseconds since the run started. */
	readonly elapsedMs: () => number;
	readonly ceilingMs: number;
	/** Renders one frame of the progress screen. */
	readonly onTick: () => void;
	readonly intervalMs: number;
	readonly sleep: (ms: number) => Promise<void>;
}

/** The ceiling for a run of `expected` trials, in milliseconds. */
export function runCeilingMs(expected: number, timeoutMultiplier: number | null): number {
	const perTrialSec = resolveTrialTimeoutSec({
		timeBudgetSec: null,
		overrideSec: null,
		multiplier: timeoutMultiplier,
	});
	return (Math.max(1, expected) * perTrialSec + RUN_WATCHDOG_GRACE_SEC) * 1000;
}

/**
 * Renders until the run finishes or the ceiling is reached, and states which happened. The caller
 * terminates the child on `ceiling`: this function decides when to stop waiting, not how to kill.
 */
export async function awaitHarborRun(options: HarborRunWaitOptions): Promise<HarborRunOutcome> {
	while (!options.finished()) {
		options.onTick();
		if (options.elapsedMs() >= options.ceilingMs) return "ceiling";
		await options.sleep(options.intervalMs);
	}
	options.onTick();
	return "finished";
}
