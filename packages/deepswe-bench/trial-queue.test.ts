/**
 * The order trials run in, and why it decides whether a truncated run is worth anything.
 *
 * THE FAILURE THIS SUITE LOCKS OUT, which happened and cost a full day of provider
 * quota. The queue used to be arm-major: every task of arm A, then every task of arm
 * B. Provider quota here is a hard daily pool, so a run that exceeds it stops
 * partway, and under arm-major ordering the pool drains during the FIRST arm. Run
 * 2026-07-25T20-46-08 came back with 10 scored `baseline` trials against 0 for
 * `sig-last1`: zero paired tasks, a verdict of "not distinguishable (underpowered)",
 * and nothing to show for the entire day's quota.
 *
 * Task-major ordering turns that same truncation into a smaller but VALID run,
 * because the cut lands on the task list rather than on an arm and every task that
 * ran carries all arms. Ten tasks across two arms is a real comparison; twenty tasks
 * of one arm and none of the other is not a comparison at all.
 *
 * Every test below therefore checks a PREFIX of the queue, since a prefix is exactly
 * what a truncated run executes.
 */

import { describe, expect, test } from "bun:test";

import { trialQueue } from "./aggregate";

/** Arms present in the first `n` trials, which is what a run cut short at `n` would produce. */
function armsInPrefix(queue: ReturnType<typeof trialQueue>, n: number): string[] {
	return [...new Set(queue.slice(0, n).map(t => t.arm))].sort();
}

/** Tasks for which the prefix contains a complete set of all arms. */
function pairedTasks(queue: ReturnType<typeof trialQueue>, n: number, armCount: number): string[] {
	const seen = new Map<string, Set<string>>();
	for (const trial of queue.slice(0, n)) {
		const arms = seen.get(trial.task) ?? new Set<string>();
		arms.add(trial.arm);
		seen.set(trial.task, arms);
	}
	return [...seen.entries()].filter(([, arms]) => arms.size === armCount).map(([task]) => task);
}

describe("trialQueue — a truncated run must still be a paired run", () => {
	const ARMS = ["baseline", "sig-max4000"];
	const TASKS = ["a", "b", "c", "d", "e"];

	/** Every cell is queued exactly once: arms x tasks x repeats, nothing dropped or duplicated. */
	test("queues every arm, task and repeat exactly once", () => {
		const queue = trialQueue(ARMS, TASKS, 2);
		expect(queue).toHaveLength(2 * 5 * 2);
		const keys = queue.map(t => `${t.arm}/${t.task}/${t.repeat}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	/**
	 * THE CORE GUARANTEE. Both arms appear within the first two trials, so a run that
	 * dies almost immediately still produced a comparison. Under the old arm-major
	 * order the second arm did not appear until trial 6 of 10.
	 */
	test("reaches every arm within the first cell", () => {
		const queue = trialQueue(ARMS, TASKS, 1);
		expect(armsInPrefix(queue, ARMS.length)).toEqual(["baseline", "sig-max4000"]);
	});

	/**
	 * THE REGRESSION, stated as the exact number that went wrong. Cut this queue at
	 * the halfway point and it yields paired tasks; the arm-major order yields NONE,
	 * because every trial so far belongs to one arm.
	 */
	test("yields paired tasks when cut in half, where arm-major yields none", () => {
		const queue = trialQueue(ARMS, TASKS, 1);
		const half = Math.floor(queue.length / 2);
		expect(pairedTasks(queue, half, ARMS.length).length).toBeGreaterThan(0);

		const armMajor = ARMS.flatMap(arm => TASKS.map(task => ({ arm, task, repeat: 0 })));
		expect(pairedTasks(armMajor, half, ARMS.length)).toEqual([]);
	});

	/**
	 * The guarantee holds at EVERY truncation point, not just a convenient one. After
	 * any whole number of cells the completed tasks are fully paired, so there is no
	 * cut length at which the run degrades into an unpaired comparison.
	 */
	test("keeps completed tasks fully paired at every cell boundary", () => {
		const queue = trialQueue(ARMS, TASKS, 1);
		for (let cells = 1; cells <= TASKS.length; cells++) {
			const n = cells * ARMS.length;
			expect(pairedTasks(queue, n, ARMS.length)).toHaveLength(cells);
		}
	});

	/**
	 * Three arms behave the same way, so the property is about the ordering rather
	 * than about there being exactly two arms. A partial cell contributes an unpaired
	 * task, which is correct and unavoidable; the completed cells stay paired.
	 */
	test("holds the same property for three arms", () => {
		const arms = ["baseline", "sig-max4000", "spill2kb"];
		const queue = trialQueue(arms, TASKS, 1);
		expect(armsInPrefix(queue, 3)).toEqual(["baseline", "sig-max4000", "spill2kb"]);
		expect(pairedTasks(queue, 6, 3)).toEqual(["a", "b"]);
	});

	/**
	 * Repeats sit between task and arm, so a cut leaves whole (task, repeat) rows
	 * across all arms. Ordering repeats outermost would reintroduce the original bug
	 * one level up: a truncation would leave repeat 0 complete and repeat 1 missing
	 * for the later arms only.
	 */
	test("completes every arm of one repeat before starting the next", () => {
		const queue = trialQueue(ARMS, ["a"], 3);
		expect(queue.map(t => `${t.repeat}:${t.arm}`)).toEqual([
			"0:baseline",
			"0:sig-max4000",
			"1:baseline",
			"1:sig-max4000",
			"2:baseline",
			"2:sig-max4000",
		]);
	});

	/** Tasks are visited in the order given, so a deliberately ordered task list is respected. */
	test("preserves the caller's task order", () => {
		const queue = trialQueue(["only"], ["z", "y", "x"], 1);
		expect(queue.map(t => t.task)).toEqual(["z", "y", "x"]);
	});

	/** Degenerate inputs produce an empty queue rather than throwing or looping. */
	test("returns an empty queue for no arms, no tasks, or no repeats", () => {
		expect(trialQueue([], TASKS, 1)).toEqual([]);
		expect(trialQueue(ARMS, [], 1)).toEqual([]);
		expect(trialQueue(ARMS, TASKS, 0)).toEqual([]);
	});
});
