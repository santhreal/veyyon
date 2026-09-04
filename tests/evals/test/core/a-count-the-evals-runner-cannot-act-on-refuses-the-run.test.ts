/**
 * WHY: the evals runner reads counts for limit, repeats, and jobs. Each wrong value cost a
 * whole run rather than the invocation:
 *  - `--limit abc` became NaN, and `NaN < totalTasksAvailable` is false, so the run measured every
 *    task in the list while the caller had asked for a subset;
 *  - `--repeats abc` sized the trial queue NaN, which queues nothing;
 *  - `--jobs abc` sized the worker pool NaN;
 *  - `--repeats 0` and `--jobs 0` are counts nothing can run.
 *
 * The class this closes is a count reaching a run as a number no loop can act on. Each is read
 * through `parseEvalsArgs`, which refuses and names the flag.
 */
import { describe, expect, it } from "bun:test";
import { CliUsageError, parseEvalsArgs } from "../../evals";

const COUNTS: readonly { flag: "limit" | "repeats" | "jobs"; read: (argv: string[]) => number | null | undefined }[] = [
	{ flag: "limit", read: argv => parseEvalsArgs(argv).limit },
	{ flag: "repeats", read: argv => parseEvalsArgs(argv).repeats },
	{ flag: "jobs", read: argv => parseEvalsArgs(argv).jobs },
];

const REFUSED: readonly string[] = ["abc", "0", "-1", "2.5", "NaN", "1e400"];

describe("a count the evals runner is given", () => {
	it("reads a positive integer, in both spellings", () => {
		for (const { flag, read } of COUNTS) {
			expect(read([`--${flag}`, "6"])).toBe(6);
			expect(read([`--${flag}=11`])).toBe(11);
		}
	});

	it("stays default or absent when the run names it nowhere", () => {
		const args = parseEvalsArgs(["--tasks", "tasks/smoke.txt"]);
		expect(args.limit).toBeNull();
		expect(args.repeats).toBe(1);
		expect(args.jobs).toBe(1);
	});

	it("refuses a value no loop could act on, naming the flag", () => {
		for (const { flag, read } of COUNTS) {
			for (const value of REFUSED) {
				const attempt = () => read([`--${flag}`, value]);
				expect(attempt).toThrow(CliUsageError);
				expect(attempt).toThrow(new RegExp(`--${flag} must be an integer >= 1`));
			}
		}
	});

	it("refuses before it reads anything else off the command line", () => {
		expect(() => parseEvalsArgs(["--harness", "baseline", "--jobs", "abc", "--tasks", "tasks/smoke.txt"])).toThrow(
			/--jobs must be an integer >= 1/,
		);
	});

	it("never reads a count as NaN, whatever else the invocation holds", () => {
		const args = parseEvalsArgs(["--harness", "baseline", "--limit", "3", "--repeats", "2", "--jobs", "4"]);

		expect([args.limit, args.repeats, args.jobs]).toEqual([3, 2, 4]);
		for (const value of [args.limit, args.repeats, args.jobs]) {
			expect(Number.isInteger(value)).toBe(true);
		}
	});
});
