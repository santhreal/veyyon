/**
 * Pooling several runs into one comparison, and every way that pooling can lie.
 *
 * WHY POOLING IS NEEDED AT ALL. A paired sign test cannot reach significance below
 * six decisive tasks, and one day of provider quota funds roughly fifteen tasks
 * across two arms. So a reward comparison strong enough to detect a regression does
 * not fit in a single day and has to accumulate. Without pooling, every such
 * comparison is stuck reporting "not distinguishable (underpowered)" forever, which
 * is exactly the verdict that would let a lever ship on a claim of "no perf loss"
 * that was never actually tested.
 *
 * WHY IT IS SOUND, and the reason the refusals below exist. Each run contains BOTH
 * arms, so a task's pair is measured under the same provider conditions, binary and
 * hour; a paired test differences the day away. That argument collapses the moment
 * a run contributes only one arm, or a different binary, or an arm whose config
 * changed. Each such case produces a confident number about nothing, and each is
 * refused rather than warned about, because a warning in a report is a thing people
 * scroll past.
 */

import { describe, expect, test } from "bun:test";

import { type ArmResult, MergeRefused, mergeRuns, type RunToMerge } from "./aggregate";

/** A minimal scored trial; only the fields the merge reads are meaningful. */
function result(arm: string, task: string, repeat = 0, reward = 1): ArmResult {
	return {
		arm,
		task,
		repeat,
		reward,
		partial: null,
		f2p: null,
		p2p: null,
		inputTokens: null,
		outputTokens: null,
		cacheTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
	} as ArmResult;
}

/** A run carrying both arms over the given tasks, which is the shape that pools soundly. */
function run(label: string, tasks: string[], overrides: Partial<RunToMerge> = {}): RunToMerge {
	return {
		label,
		model: "google-antigravity/gemini-3-pro",
		binarySha: "abc123",
		armFingerprints: { baseline: "fp-base", "sig-max4000": "fp-sig" },
		results: tasks.flatMap(task => [result("baseline", task), result("sig-max4000", task)]),
		...overrides,
	};
}

describe("mergeRuns — accumulating days into one powered comparison", () => {
	/**
	 * THE CASE THIS EXISTS FOR. Two days of ten tasks each become one comparison over
	 * twenty tasks, which is the difference between a sign test that can reach
	 * significance and one that structurally cannot.
	 */
	test("pools two runs into one set covering both task lists", () => {
		const merged = mergeRuns([run("day1", ["a", "b"]), run("day2", ["c", "d"])]);
		expect(merged.results).toHaveLength(8);
		expect([...new Set(merged.results.map(r => r.task))].sort()).toEqual(["a", "b", "c", "d"]);
		expect([...new Set(merged.results.map(r => r.arm))].sort()).toEqual(["baseline", "sig-max4000"]);
		expect(merged.model).toBe("google-antigravity/gemini-3-pro");
	});

	/**
	 * The same task measured on two days is TWO SAMPLES of one cell, not a collision.
	 * Leaving both at repeat 0 would give two rows the aggregator reads as one cell
	 * measured once, and one of the two measurements would be silently discarded or
	 * double-counted depending on how it folds.
	 */
	test("renumbers repeats so a task measured twice becomes two samples", () => {
		const merged = mergeRuns([run("day1", ["a"]), run("day2", ["a"])]);
		const baseline = merged.results.filter(r => r.arm === "baseline" && r.task === "a");
		expect(baseline.map(r => r.repeat).sort()).toEqual([0, 1]);
	});

	/**
	 * Repeats are numbered PER CELL, so one arm's numbering never depends on how many
	 * samples the other arm happens to have. Sharing a counter across arms would make
	 * the repeat index meaningless as a sample identifier.
	 */
	test("numbers repeats independently for each arm and task", () => {
		const merged = mergeRuns([run("day1", ["a", "b"]), run("day2", ["a"])]);
		const cell = (arm: string, task: string) =>
			merged.results.filter(r => r.arm === arm && r.task === task).map(r => r.repeat);
		expect(cell("baseline", "a")).toEqual([0, 1]);
		expect(cell("sig-max4000", "a")).toEqual([0, 1]);
		expect(cell("baseline", "b")).toEqual([0]);
	});

	/**
	 * THE REFUSAL THAT MATTERS MOST. Pooling a baseline-only run with a
	 * treatment-only run puts the entire day effect on one arm, where it is
	 * indistinguishable from the treatment. That is not a degraded comparison, it is a
	 * fabricated one, and it is the obvious thing to try when one day's run dies on
	 * quota partway through.
	 */
	test("refuses to pool runs that do not each carry the same arms", () => {
		const baselineOnly: RunToMerge = {
			...run("day2", []),
			results: [result("baseline", "c"), result("baseline", "d")],
		};
		expect(() => mergeRuns([run("day1", ["a", "b"]), baselineOnly])).toThrow(MergeRefused);
		expect(() => mergeRuns([run("day1", ["a", "b"]), baselineOnly])).toThrow(/different arms|arms \[/);
	});

	/**
	 * Two providers averaged into one number describe neither. This is easy to do by
	 * accident, because the run directories look alike and only `results.json` records
	 * which model produced them.
	 */
	test("refuses to pool runs from different models", () => {
		const other = run("day2", ["c"], { model: "google-antigravity/claude-sonnet-4-6" });
		expect(() => mergeRuns([run("day1", ["a"]), other])).toThrow(/different models/);
	});

	/**
	 * A different binary means the delta includes whatever else changed in the build.
	 * The arm would get credit or blame for an unrelated commit, which is the same
	 * confound the single-variable rule exists to prevent.
	 */
	test("refuses to pool runs built from different binaries", () => {
		const other = run("day2", ["c"], { binarySha: "def456" });
		expect(() => mergeRuns([run("day1", ["a"]), other])).toThrow(/different binaries/);
	});

	/**
	 * THE CASE A READER WOULD NEVER CATCH BY EYE: the same arm NAME pointing at a
	 * different config on two days. Every row still says `sig-max4000`, the report
	 * renders cleanly, and the number is the average of two different treatments.
	 * Nothing downstream can detect this, so it has to be refused here.
	 */
	test("refuses to pool an arm whose config changed between runs", () => {
		const other = run("day2", ["c"], {
			armFingerprints: { baseline: "fp-base", "sig-max4000": "fp-sig-CHANGED" },
		});
		expect(() => mergeRuns([run("day1", ["a"]), other])).toThrow(/different configs/);
	});

	/**
	 * A missing fingerprint is not evidence of a mismatch. Older runs predate the
	 * field, and refusing on absence would make the whole mechanism unusable against
	 * exactly the historical runs it is most needed for.
	 */
	test("pools runs where one predates fingerprint recording", () => {
		const old = run("day0", ["z"], { armFingerprints: null });
		expect(() => mergeRuns([old, run("day1", ["a"])])).not.toThrow();
	});

	/** Merging nothing is a caller mistake, not an empty success. */
	test("refuses an empty set of runs", () => {
		expect(() => mergeRuns([])).toThrow(MergeRefused);
	});

	/** A single run pools to itself unchanged, so the merge path is not a special case. */
	test("returns a single run's results unchanged", () => {
		const merged = mergeRuns([run("day1", ["a", "b"])]);
		expect(merged.results).toHaveLength(4);
		expect(merged.results.every(r => r.repeat === 0)).toBe(true);
	});

	/**
	 * Output ordering is deterministic regardless of the order runs are passed in, so
	 * two people merging the same days get byte-identical reports and a diff between
	 * them means a real difference rather than an argument order.
	 */
	test("sorts deterministically however the runs are ordered", () => {
		const forward = mergeRuns([run("day1", ["a"]), run("day2", ["b"])]);
		const backward = mergeRuns([run("day2", ["b"]), run("day1", ["a"])]);
		const key = (rs: ArmResult[]) => rs.map(r => `${r.arm}/${r.task}/${r.repeat}`).join(",");
		expect(key(forward.results)).toBe(key(backward.results));
	});

	/**
	 * The merge must not mutate what it was given. A caller that merges and then reads
	 * its own inputs, as the CLI does when reporting which runs were pooled, would
	 * otherwise see repeat indices rewritten underneath it.
	 */
	test("leaves the input runs untouched", () => {
		const first = run("day1", ["a"]);
		const second = run("day2", ["a"]);
		mergeRuns([first, second]);
		expect(second.results.every(r => r.repeat === 0)).toBe(true);
		expect(first.results.every(r => r.repeat === 0)).toBe(true);
	});
});
