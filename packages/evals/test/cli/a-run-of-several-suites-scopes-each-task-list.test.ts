/**
 * WHY THIS SUITE EXISTS. The suite axis used to hold one name, so an operator
 * comparing eval sets ran the CLI once per suite and stitched the results by hand.
 * It now takes a list, and that introduces a routing question every multi-axis
 * runner gets wrong the first time: which task list belongs to which suite. A
 * `--tasks` entry that silently applies to the wrong suite spends money on tasks
 * that do not exist, and a prefix naming a suite the run does not include is a
 * typo that must not vanish.
 *
 * THE CLASS: an axis that grew from one value to many must route every scoped
 * input to exactly one member, refuse a scope naming a non-member, and keep the
 * unscoped case working for every member. Options that can only mean one suite
 * (`--dataset-dir`) must refuse a multi-suite run instead of picking one.
 *
 * WHAT IT DOES NOT CATCH: whether a suite's own discovery accepts the ids it is
 * handed. That is the suite's contract, proven where the suite is proven.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { CliUsageError, main, parseEvalsArgs, tasksForSuite } from "../../evals";

const RUNNING = ["deep-swe", "terminal-bench"] as const;

/** Captures what the CLI wrote to a stream, without letting it reach the terminal. */
function capture(stream: "stdout" | "stderr"): { text: () => string } {
	const chunks: string[] = [];
	const spy = spyOn(process[stream], "write").mockImplementation(chunk => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { text: () => (spy.mock.calls.length === 0 ? "" : chunks.join("")) };
}

afterEach(() => {
	spyOn(process.stdout, "write").mockRestore();
	spyOn(process.stderr, "write").mockRestore();
});

describe("a task list scoped to one suite", () => {
	it("reaches only the suite named in its prefix", () => {
		const tasks = ["deep-swe=lists/deep.txt", "terminal-bench=lists/tb.txt"];

		expect(tasksForSuite(tasks, "deep-swe", RUNNING)).toEqual(["lists/deep.txt"]);
		expect(tasksForSuite(tasks, "terminal-bench", RUNNING)).toEqual(["lists/tb.txt"]);
	});

	it("leaves an unprefixed entry applying to every suite", () => {
		const tasks = ["task-one", "task-two"];

		expect(tasksForSuite(tasks, "deep-swe", RUNNING)).toEqual(tasks);
		expect(tasksForSuite(tasks, "terminal-bench", RUNNING)).toEqual(tasks);
	});

	it("prefers the scoped entries of a suite over the unscoped ones", () => {
		const tasks = ["shared-id", "terminal-bench=lists/tb.txt"];

		expect(tasksForSuite(tasks, "terminal-bench", RUNNING)).toEqual(["lists/tb.txt"]);
		expect(tasksForSuite(tasks, "deep-swe", RUNNING)).toEqual(["shared-id"]);
	});

	it("refuses a prefix naming a suite the run does not include", () => {
		expect(() => tasksForSuite(["typescript-edit=lists/x.txt"], "deep-swe", RUNNING)).toThrow(CliUsageError);
		expect(() => tasksForSuite(["typescript-edit=lists/x.txt"], "deep-swe", RUNNING)).toThrow(
			/names suite "typescript-edit", which this run does not include \(deep-swe, terminal-bench\)/,
		);
	});

	it("keeps an id that merely contains an equals sign out of the scoping rule", () => {
		expect(() => tasksForSuite(["a=b=c"], "deep-swe", RUNNING)).toThrow(/names suite "a"/);
		expect(tasksForSuite(["plain-id"], "deep-swe", RUNNING)).toEqual(["plain-id"]);
	});
});

describe("an option that can only mean one suite", () => {
	it("refuses --dataset-dir when the run names several suites", async () => {
		const stderr = capture("stderr");

		const code = await main(["--suite", "deep-swe,terminal-bench", "--model", "x/y", "--dataset-dir", "/tmp/ds"]);

		expect(code).toBe(2);
		expect(stderr.text()).toContain("--dataset-dir names one suite's dataset");
		expect(stderr.text()).toContain("deep-swe, terminal-bench");
	});

	it("accepts --dataset-dir for a single suite", () => {
		const args = parseEvalsArgs(["--suite", "deep-swe", "--dataset-dir", "/ds"]);

		expect(args.suites).toEqual(["deep-swe"]);
		expect(args.datasetDir).toBe("/ds");
	});
});

describe("a suite name the registry does not know", () => {
	it("is reported as a usage error rather than a crash", async () => {
		const stderr = capture("stderr");

		const code = await main(["--suite", "deep-swe,not-a-suite", "--model", "x/y"]);

		expect(code).toBe(2);
		expect(stderr.text()).toContain("not-a-suite");
	});

	it("names every suite that is required to run", async () => {
		const stderr = capture("stderr");

		const code = await main(["--suite", "deep-swe,terminal-bench"]);

		expect(code).toBe(2);
		expect(stderr.text()).toContain("--model is required to run deep-swe, terminal-bench");
	});
});
