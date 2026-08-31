/**
 * WHY: the harbor runner waited on its child in `while (!finished)` with nothing else able to end the
 * loop.
 *
 * A harbor that never exits — a container wedged on an image pull, a compose project waiting on a
 * lock — left the runner rendering a progress screen forever. Its manager row stayed at running, no
 * report was written, and nothing distinguished a slow run from a dead one. The one exit from that
 * loop was the child exiting, which is exactly what was not happening.
 *
 * THE CLASS THIS CLOSES: a progress loop with no ceiling. `awaitHarborRun` states which of the two
 * ways a run can end happened, and the ceiling is derived from the trials' own budgets rather than a
 * fixed number, so a legitimately long run cannot trip it. Every path is driven with an injected
 * clock and sleep — the child finishing, the ceiling arriving, a child already finished before the
 * first frame — so no case depends on real time.
 *
 * WHAT IT DOES NOT CATCH: whether the CLI terminates the tree and reports code 124 on `ceiling`. That
 * lives inside `runBenchmark`, which spawns the real `harbor` binary; what is pinned here is the exit
 * code the CLI uses and the ceiling it computes.
 */

import { describe, expect, it } from "bun:test";
import {
	awaitHarborRun,
	RUN_CEILING_EXIT_CODE,
	RUN_WATCHDOG_GRACE_SEC,
	runCeilingMs,
} from "../../backends/harbor/run-watchdog";
import { DEFAULT_TRIAL_TIMEOUT_SEC } from "../../engine/trial-deadline";

interface FakeClock {
	readonly elapsedMs: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly slept: number[];
}

/** Time moves only when the loop sleeps, so every case is deterministic. */
function fakeClock(): FakeClock {
	let now = 0;
	const slept: number[] = [];
	return {
		elapsedMs: () => now,
		sleep: async (ms: number) => {
			slept.push(ms);
			now += ms;
		},
		slept,
	};
}

describe("waiting for one harbor invocation", () => {
	it("returns when the child exits, and renders the final frame", async () => {
		const clock = fakeClock();
		let frames = 0;
		let cycles = 0;

		const outcome = await awaitHarborRun({
			finished: () => cycles >= 3,
			elapsedMs: clock.elapsedMs,
			ceilingMs: 60_000,
			onTick: () => {
				frames++;
				cycles++;
			},
			intervalMs: 700,
			sleep: clock.sleep,
		});

		expect(outcome).toBe("finished");
		// Three frames while running, one after: the screen ends on the run's last state.
		expect(frames).toBe(4);
		expect(clock.slept).toEqual([700, 700, 700]);
	});

	it("stops at the ceiling when the child never exits", async () => {
		const clock = fakeClock();
		let frames = 0;

		const outcome = await awaitHarborRun({
			// The child never exits within the ceiling. The escape hatch far beyond it keeps a build
			// that dropped the ceiling check failing with a wrong count instead of looping forever.
			finished: () => clock.slept.length >= 50,
			elapsedMs: clock.elapsedMs,
			ceilingMs: 2100,
			onTick: () => {
				frames++;
			},
			intervalMs: 700,
			sleep: clock.sleep,
		});

		expect(outcome).toBe("ceiling");
		expect(clock.slept).toEqual([700, 700, 700]);
		expect(frames).toBe(4);
	});

	it("renders once and returns when the child exited before the first frame", async () => {
		const clock = fakeClock();
		let frames = 0;

		const outcome = await awaitHarborRun({
			finished: () => true,
			elapsedMs: clock.elapsedMs,
			ceilingMs: 60_000,
			onTick: () => {
				frames++;
			},
			intervalMs: 700,
			sleep: clock.sleep,
		});

		expect(outcome).toBe("finished");
		expect(frames).toBe(1);
		expect(clock.slept).toEqual([]);
	});

	it("derives the ceiling from the trials the run expects, not a fixed number", () => {
		const oneTrial = runCeilingMs(1, null);
		const tenTrials = runCeilingMs(10, null);

		expect(oneTrial).toBe((DEFAULT_TRIAL_TIMEOUT_SEC + RUN_WATCHDOG_GRACE_SEC) * 1000);
		expect(tenTrials).toBe((10 * DEFAULT_TRIAL_TIMEOUT_SEC + RUN_WATCHDOG_GRACE_SEC) * 1000);
		// A run of no trials still gets one trial's worth rather than only the grace.
		expect(runCeilingMs(0, null)).toBe(oneTrial);
	});

	it("scales the ceiling with the run's timeout multiplier", () => {
		expect(runCeilingMs(4, 2)).toBeGreaterThan(runCeilingMs(4, null));
		expect(runCeilingMs(4, null)).toBe(runCeilingMs(4, 1));
	});

	it("pins the grace and the exit code a ceiling produces", () => {
		// Literals: the cases above compute from these, so a drift would leave this file green.
		expect(RUN_WATCHDOG_GRACE_SEC).toBe(600);
		expect(RUN_CEILING_EXIT_CODE).toBe(124);
	});
});
