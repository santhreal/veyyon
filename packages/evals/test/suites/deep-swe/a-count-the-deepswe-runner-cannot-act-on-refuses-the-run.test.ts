/**
 * WHY: the deep-swe runner is the entry point the manager spawns for pier runs, and three of its
 * counts reached the executor through `raw.x ? Number(raw.x) : undefined`. Each wrong value cost a
 * whole run rather than the invocation:
 *  - `--limit abc` became NaN, and `NaN < totalTasksAvailable` is false, so the run measured every
 *    task in the list while the caller had asked for a subset;
 *  - `--repeats abc` sized the trial queue NaN, which queues nothing;
 *  - `--jobs abc` sized the worker pool NaN;
 *  - `--repeats 0` and `--jobs 0` are counts nothing can run.
 *
 * The class this closes is a count reaching a run as a number no loop can act on. Each is read
 * through the grammar's `flagCount`, which refuses and names the flag; a run's plan states the
 * count it will use rather than deriving it a second time.
 *
 * It does not check what the executor does with a valid count (the queue and pool are covered by
 * the runner suites), and it does not cover `--trial-timeout`, which the runner validates against
 * the deadline owner and reports as InvalidTrialTimeoutError.
 */
import { describe, expect, it } from "bun:test";
import { FlagValueError } from "../../../src/core/flags";
import { parseBenchCliArgs } from "../../../src/suites/deep-swe/runner/cli-args";

const COUNTS: readonly { flag: "limit" | "repeats" | "jobs"; read: (argv: string[]) => number | undefined }[] = [
	{ flag: "limit", read: argv => parseBenchCliArgs(argv).limit },
	{ flag: "repeats", read: argv => parseBenchCliArgs(argv).repeats },
	{ flag: "jobs", read: argv => parseBenchCliArgs(argv).jobs },
];

const REFUSED: readonly string[] = ["abc", "0", "-1", "2.5", "NaN", "1e400"];

describe("a count the deep-swe runner is given", () => {
	it("reads a positive integer, in both spellings", () => {
		for (const { flag, read } of COUNTS) {
			expect(read([`--${flag}`, "6"])).toBe(6);
			expect(read([`--${flag}=11`])).toBe(11);
		}
	});

	it("stays absent when the run names it nowhere, so the runner applies its own default", () => {
		for (const { read } of COUNTS) expect(read(["--tasks", "tasks/smoke.txt"])).toBeUndefined();
	});

	it("refuses a value no loop could act on, naming the flag", () => {
		for (const { flag, read } of COUNTS) {
			for (const value of REFUSED) {
				const attempt = () => read([`--${flag}`, value]);
				expect(attempt).toThrow(FlagValueError);
				expect(attempt).toThrow(new RegExp(`--${flag} expects`));
			}
		}
	});

	it("refuses before it reads anything else off the command line", () => {
		// The refusal does not depend on the rest of the invocation being resolvable.
		expect(() => parseBenchCliArgs(["--arms", "baseline", "--jobs", "abc", "--tasks", "tasks/smoke.txt"])).toThrow(
			/--jobs expects/,
		);
	});

	it("never reads a count as NaN, whatever else the invocation holds", () => {
		const args = parseBenchCliArgs(["--arms", "baseline", "--limit", "3", "--repeats", "2", "--jobs", "4"]);

		expect([args.limit, args.repeats, args.jobs]).toEqual([3, 2, 4]);
		for (const value of [args.limit, args.repeats, args.jobs]) {
			expect(Number.isInteger(value)).toBe(true);
		}
	});
});
