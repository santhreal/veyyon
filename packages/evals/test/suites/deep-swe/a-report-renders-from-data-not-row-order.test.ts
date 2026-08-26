/**
 * WHY THIS SUITE DEFENDS REPORT DETERMINISM AND SINGLE-OWNER BLANK TRIAL INTEGRITY.
 *
 * Aggregate benchmark reports must render byte-identically regardless of row input
 * order or arm interleaving. The blank trial result must have a single authoritative
 * owner (`emptyArmResult`) that sets every field defined on `ArmResult` to null,
 * structurally verified against `ARM_RESULT_FIELDS` to prevent forgotten properties.
 *
 * What this does not catch: terminal display differences across disparate TUI renderers.
 */

import { describe, expect, test } from "bun:test";
import type { ArmResult } from "../../../src/core/arm-result";
import { emptyArmResult } from "../../../src/suites/deep-swe/aggregate";
import { renderReport } from "../../../src/suites/deep-swe/src/aggregate/report-render";
import { ARM_RESULT_FIELDS } from "../../../src/suites/deep-swe/src/aggregate/types";
import { res } from "./aggregate-test-helpers";

describe("renderReport is reproducible — output depends on data, not row order", () => {
	// An eval set is iterated on for months, so two renders of the SAME run must
	// produce the same bytes or report-to-report diffs become unreadable. Rows do
	// NOT arrive in a stable order: a live run appends them as jobs finish (which
	// depends on --jobs and on which container is slow) while a reaggregate rebuilds
	// them in readdir order. Arm order was previously taken from that arrival order,
	// so the same run could render "baseline → full" once and "full → baseline" the
	// next time, inverting the sign of every delta.

	function sampleRows(): ArmResult[] {
		const rows: ArmResult[] = [];
		for (let i = 1; i <= 6; i++) {
			rows.push(res({ arm: "full", task: `t${i}`, reward: i <= 4 ? 1 : 0, outputTokens: 900 + i }));
			rows.push(res({ arm: "baseline", task: `t${i}`, reward: i <= 2 ? 1 : 0, outputTokens: 1000 + i }));
			rows.push(res({ arm: "decode", task: `t${i}`, reward: i <= 3 ? 1 : 0, outputTokens: 950 + i }));
		}
		return rows;
	}

	test("a reversed row order renders byte-identically", () => {
		const forward = renderReport(sampleRows(), "m", "now", 1);
		const reversed = renderReport([...sampleRows()].reverse(), "m", "now", 1);
		expect(reversed).toBe(forward);
	});

	test("grouping rows by arm renders byte-identically to interleaved rows", () => {
		// The realistic divergence: a reaggregate walks one arm's job directory at a
		// time, while a live run interleaves arms as containers finish.
		const grouped = [...sampleRows()].sort((a, b) => a.arm.localeCompare(b.arm));
		expect(renderReport(grouped, "m", "now", 1)).toBe(renderReport(sampleRows(), "m", "now", 1));
	});

	test("pair direction is fixed by name, so deltas never invert between renders", () => {
		// The concrete consequence. Whichever arm's rows land first, the comparison
		// must always read baseline → full, never the reverse.
		for (const rows of [sampleRows(), [...sampleRows()].reverse()]) {
			const md = renderReport(rows, "m", "now", 1);
			expect(md).toContain("| baseline → full |");
			expect(md).not.toContain("| full → baseline |");
		}
	});
});

describe("emptyArmResult — one owner for the blank trial result", () => {
	/**
	 * WHY THESE EXIST. The blank ArmResult was hand-written in three places in
	 * `run.ts` (the parse path, the per-trial error path, and the reaggregate error
	 * path) and a fourth time as this suite's own fixture. The copies had already
	 * drifted in different directions: the parse path omitted `error`, and the
	 * reaggregate error path omitted `argotHandlesLoaded` and `encodeHeadroom`.
	 *
	 * That last drift is the damaging one. Those two fields are what make a
	 * `0 encoded` run interpretable at all: how many handles the dictionary
	 * actually loaded, and the headroom the trial could have used. Re-aggregating a
	 * finished run therefore rewrote its results.json into the older format where
	 * "the model ignored the handles" and "there were no handles" are
	 * indistinguishable, which is the exact confusion EVAL-ARGOT-NEVER-ENCODED is
	 * blocked on. Nothing caught it because the package declared no `check:types`
	 * and the workspace typecheck skipped it with `--if-present`.
	 */

	/** The three identity fields are the only inputs, and they must arrive intact. */
	test("carries the trial's identity through unchanged", () => {
		const blank = emptyArmResult("full-budget16k", "django__django-11099", 3);
		expect(blank.arm).toBe("full-budget16k");
		expect(blank.task).toBe("django__django-11099");
		expect(blank.repeat).toBe(3);
	});

	/**
	 * Every measurement starts unknown. `null` is not interchangeable with 0 here:
	 * a defaulted 0 would claim the dictionary loaded no handles and that the trial
	 * made no tool calls, turning missing data into a measured result.
	 */
	test("leaves every measurement null, never zero", () => {
		const blank = emptyArmResult("a", "t", 0);
		const { arm: _a, task: _t, repeat: _r, ...measurements } = blank;
		const nonNull = Object.entries(measurements).filter(([, value]) => value !== null);
		expect(nonNull).toEqual([]);
	});

	/**
	 * The three fields the drifted copies dropped, named explicitly. A generic
	 * "all null" assertion passes just as happily on an object that is missing
	 * them, since `undefined !== null` never gets compared when the key is absent.
	 */
	test("declares the three fields the hand-written copies had dropped", () => {
		const blank = emptyArmResult("a", "t", 0);
		for (const key of ["error", "argotHandlesLoaded", "encodeHeadroom"] as const) {
			expect(Object.hasOwn(blank, key), `${key} must be present, not merely undefined`).toBe(true);
			expect(blank[key]).toBeNull();
		}
	});

	/**
	 * A fresh object per call. Returning a shared constant would let one trial's
	 * parsed reward leak into every later blank result.
	 */
	test("returns an independent object each call", () => {
		const first = emptyArmResult("a", "t", 0);
		const second = emptyArmResult("a", "t", 0);
		expect(first).not.toBe(second);
		first.reward = 1;
		expect(second.reward).toBeNull();
	});
});

describe("emptyArmResult exhaustiveness — all ArmResult fields are initialized", () => {
	/**
	 * Structural invariant: emptyArmResult is the one owner of the blank trial shape.
	 * Every field declared on ArmResult must be set on emptyArmResult (as null/identity),
	 * so adding a field to ArmResult and ARM_RESULT_FIELDS without initializing it
	 * in emptyArmResult fails this test.
	 */
	test("emptyArmResult declares every field in ARM_RESULT_FIELDS", () => {
		const blank = emptyArmResult("arm-a", "task-1", 0);
		const actualKeys = Object.keys(blank).sort();
		const expectedKeys = [...ARM_RESULT_FIELDS].sort();
		expect(actualKeys).toEqual(expectedKeys);
	});
});
