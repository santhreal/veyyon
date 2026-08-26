/**
 * WHY THIS SUITE DEFENDS REPRODUCIBLE TASK SELECTION, PROVENANCE, AND PRICING.
 *
 * Benchmark task subsampling must span the task corpus deterministically rather
 * than taking an alphabetical prefix. Task list provenance must explicitly banner
 * selection bias in reports, job naming must round-trip across repeat indices,
 * and unpriced provider runs must never be rendered as free ($0.000).
 *
 * What this does not catch: external dataset changes where task identifiers remain constant.
 */

import { describe, expect, test } from "bun:test";
import {
	jobNameOf,
	parseJobName,
	parseTaskListProvenance,
	selectTasks,
} from "../../../src/suites/deep-swe/aggregate/merge";
import {
	costIsUnpriced,
	fmtCost,
	renderReport,
	renderTaskSetProvenanceBanner,
} from "../../../src/suites/deep-swe/aggregate/report-render";
import { summarizeCell } from "../../../src/suites/deep-swe/aggregate/stats";
import type { ArmResult } from "../../../src/suites/deep-swe/aggregate/types";
import { res } from "./aggregate-test-helpers";

describe("jobNameOf / parseJobName — the reaggregate round-trip", () => {
	// reaggregate rebuilds results from job-name strings alone, so a mismatch
	// between how a name is written and how it is read would silently file a
	// sample under the wrong task or repeat. These lock the two functions as exact
	// inverses across the shapes the bench actually produces.

	test("a single-sample run keeps the historic arm__task name (no suffix)", () => {
		// Backward compatibility: runs produced before --repeats existed have no
		// suffix and must still parse to repeat 0, or old runs stop reaggregating.
		expect(jobNameOf("full", "koota-query-predicates", 0, 1)).toBe("full__koota-query-predicates");
		expect(parseJobName("full__koota-query-predicates")).toEqual({
			arm: "full",
			task: "koota-query-predicates",
			repeat: 0,
		});
	});

	test("a repeated run appends __r<n> and parses it back to the repeat index", () => {
		expect(jobNameOf("baseline", "etree-xml-diff-patch", 2, 3)).toBe("baseline__etree-xml-diff-patch__r2");
		expect(parseJobName("baseline__etree-xml-diff-patch__r2")).toEqual({
			arm: "baseline",
			task: "etree-xml-diff-patch",
			repeat: 2,
		});
	});

	test("round-trips every cell of a small grid so no sample is misfiled", () => {
		for (const arm of ["baseline", "argot-setting-only", "candidate-argot-nudge"]) {
			for (const task of ["fastapi-implicit-head-options", "ytt-jsonpath-query-api"]) {
				for (const repeats of [1, 5]) {
					for (let repeat = 0; repeat < repeats; repeat++) {
						const name = jobNameOf(arm, task, repeat, repeats);
						expect(parseJobName(name)).toEqual({ arm, task, repeat: repeats > 1 ? repeat : 0 });
					}
				}
			}
		}
	});

	test("a two-digit repeat index (K > 9) still parses", () => {
		// The suffix regex is \d+, not a single digit; K=20 must not truncate r10.
		expect(parseJobName(jobNameOf("full", "some-task", 10, 20))).toEqual({
			arm: "full",
			task: "some-task",
			repeat: 10,
		});
	});
});

describe("selectTasks — a --limit subsample must be representative, not the alphabetical head", () => {
	// The bug this locks out: `sorted.slice(0, limit)`. DeepSWE task names are
	// repo-prefixed, so the first N cluster on one repo and a pass rate over them is
	// a biased estimate of the whole-suite rate. selectTasks must spread the picks
	// across the sorted range while staying fully deterministic (a limited run has to
	// stay reproducible and reaggregatable).

	const suite = Array.from({ length: 100 }, (_, i) => `task-${String(i).padStart(3, "0")}`);

	test("returns the whole set (a copy) when no limit is given", () => {
		const picked = selectTasks(suite, undefined);
		expect(picked).toEqual(suite);
		expect(picked).not.toBe(suite); // a copy, so callers can mutate without aliasing
	});

	test("returns the whole set when the limit meets or exceeds the size", () => {
		expect(selectTasks(suite, 100)).toEqual(suite);
		expect(selectTasks(suite, 1000)).toEqual(suite);
	});

	test("spans the whole range instead of clustering at the head (the anti-bias property)", () => {
		// slice(0,10) would return task-000..task-009 (all clustered). Even stride over
		// 100 tasks at limit 10 lands one pick per contiguous decile, so the last pick is
		// near the end of the suite, not the start.
		const picked = selectTasks(suite, 10);
		expect(picked).toEqual([
			"task-000",
			"task-010",
			"task-020",
			"task-030",
			"task-040",
			"task-050",
			"task-060",
			"task-070",
			"task-080",
			"task-090",
		]);
		// Concretely: this is NOT the biased head slice.
		expect(picked).not.toEqual(suite.slice(0, 10));
	});

	test("is deterministic: the same limit always selects the same tasks", () => {
		expect(selectTasks(suite, 7)).toEqual(selectTasks(suite, 7));
	});

	test("picks distinct, in-range tasks and never duplicates or overflows", () => {
		for (const limit of [1, 2, 3, 13, 37, 99]) {
			const picked = selectTasks(suite, limit);
			expect(picked).toHaveLength(limit);
			expect(new Set(picked).size).toBe(limit); // no repeats
			for (const t of picked) expect(suite).toContain(t); // every pick is a real task
		}
	});

	test("limit of zero or below selects nothing (guarded upstream, defended here)", () => {
		expect(selectTasks(suite, 0)).toEqual([]);
		expect(selectTasks(suite, -5)).toEqual([]);
	});
});

describe("parseTaskListProvenance — a selection-biased task set is never a silent headline", () => {
	// The methodology defect this locks out: argot-10.txt is EXPLICITLY the tasks whose
	// repos compress best ("most repeated-token mass"), so a big saving on it is a
	// best-case upper bound, not argot's real effect. A task list declares its status in
	// a header directive so the report can warn; this parses exactly that directive.

	test("a @biased directive marks the set biased and captures its reason", () => {
		const prov = parseTaskListProvenance("# @biased: repos chosen for max compressible mass\ntask-a\ntask-b\n");
		expect(prov).toEqual({ marked: true, biased: true, note: "repos chosen for max compressible mass" });
	});

	test("a @headline directive marks the set unbiased", () => {
		const prov = parseTaskListProvenance("# @headline: unbiased held-out set\nytt-jsonpath-query-api\n");
		expect(prov).toEqual({ marked: true, biased: false, note: "unbiased held-out set" });
	});

	test("a bare @headline with no note is still marked, note null", () => {
		expect(parseTaskListProvenance("# @headline\ntask-a\n")).toEqual({ marked: true, biased: false, note: null });
	});

	test("no directive at all reads unmarked, so the report can nudge for one", () => {
		// The old plain task lists: the report must not silently assume headline; it flags
		// the missing provenance instead.
		expect(parseTaskListProvenance("# just a description\ntask-a\ntask-b\n")).toEqual({
			marked: false,
			biased: false,
			note: null,
		});
	});

	test("a directive only counts in the HEADER, above the first task (no spoofing)", () => {
		// Scanning stops at the first non-comment line, so a task named to look like a
		// directive (or a trailing comment) cannot flip a headline set to biased.
		const prov = parseTaskListProvenance("# @headline\ntask-a\n# @biased: sneaky trailing comment\n");
		expect(prov).toEqual({ marked: true, biased: false, note: null });
	});

	test("real argot-10 and diverse-20 headers classify correctly", () => {
		// The two real files this feature exists for: the compression-optimized pilot is
		// biased, the held-out diverse set is a headline.
		expect(parseTaskListProvenance("# @biased: maximal repeated-token mass\nkgateway-x\n").biased).toBe(true);
		expect(parseTaskListProvenance("# @headline: unbiased held-out\nytt-x\n").biased).toBe(false);
	});
});

describe("renderTaskSetProvenanceBanner / renderReport — the provenance banner is loud", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("a biased set renders a prominent best-case warning with its reason", () => {
		const banner = renderTaskSetProvenanceBanner({ marked: true, biased: true, note: "max compressible mass" });
		expect(banner).toContain("SELECTION-BIASED");
		expect(banner).toContain("NOT a headline");
		expect(banner).toContain("max compressible mass");
	});

	test("a headline set renders a calm confirmation, no warning", () => {
		const banner = renderTaskSetProvenanceBanner({ marked: true, biased: false, note: "held-out" });
		expect(banner).toContain("headline (unbiased)");
		expect(banner).not.toContain("SELECTION-BIASED");
	});

	test("an unmarked set nudges the author to declare provenance", () => {
		const banner = renderTaskSetProvenanceBanner({ marked: false, biased: false, note: null });
		expect(banner).toContain("unmarked");
		expect(banner).toContain("@headline");
		expect(banner).toContain("@biased");
	});

	test("renderReport prints the biased banner near the top when a task set is given", () => {
		// End to end: a report built from a biased set must carry the warning so no reader
		// mistakes a best-case saving for a headline. Omitting the task set (older runs /
		// fixtures) prints no banner, keeping every prior report test valid.
		const results: ArmResult[] = [res({ arm: "full", task: "t1", reward: 1 })];
		const withBias = renderReport(results, "m", STAMP, 1, { marked: true, biased: true, note: "best-case repos" });
		expect(withBias).toContain("SELECTION-BIASED");
		expect(withBias).toContain("best-case repos");
		const without = renderReport(results, "m", STAMP, 1);
		expect(without).not.toContain("SELECTION-BIASED");
	});
});

describe("costIsUnpriced / fmtCost — a provider that reports no price is never shown as $0.000", () => {
	// WHY THIS SUITE EXISTS. The bench runs subscription-tier models (google-antigravity
	// flash) whose provider returns `usage.cost.total: 0` on every message while the
	// model burns thousands of tokens: the 0 means "never priced", not "free". Summing
	// it and printing `$0.000` is a silent fallback (Law 10) — it reads as a real, cheap
	// price and lets a cost verdict rest on a number the provider never produced. The
	// summary and per-task columns must instead read `unpriced` / `—`, and the report
	// must say why once, loudly. A genuinely priced arm must still show its dollars.
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("an arm with 0 cost but real output tokens is unpriced, not free", () => {
		// The exact google-antigravity signature: tokens flowed, cost stayed 0.
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 900, costUsd: 0 }),
			res({ reward: 0, outputTokens: 1100, costUsd: 0 }),
		]);
		expect(s.costPriced).toBe(false);
		expect(costIsUnpriced(s)).toBe(true);
		expect(fmtCost(s, "sum")).toBe("unpriced");
		expect(fmtCost(s, "mean")).toBe("—");
	});

	test("an arm with a real positive cost is priced and shows dollars", () => {
		// The contrast case: any positive provider cost proves the model is priced,
		// so the dollar figure is real and must be rendered, not hidden.
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 900, costUsd: 0.12 }),
			res({ reward: 1, outputTokens: 800, costUsd: 0.1 }),
		]);
		expect(s.costPriced).toBe(true);
		expect(costIsUnpriced(s)).toBe(false);
		expect(fmtCost(s, "sum")).toBe("$0.220");
		expect(fmtCost(s, "mean")).toBe("$0.110");
	});

	test("a mix where at least one run is priced counts the whole arm as priced", () => {
		// If even one run carried a price, the model IS priced; the zeros are just
		// runs the provider happened not to bill, not evidence of an unpriced model.
		const s = summarizeCell([
			res({ reward: 1, outputTokens: 900, costUsd: 0 }),
			res({ reward: 1, outputTokens: 800, costUsd: 0.05 }),
		]);
		expect(s.costPriced).toBe(true);
		expect(costIsUnpriced(s)).toBe(false);
		expect(fmtCost(s, "sum")).toBe("$0.050");
	});

	test("an all-errored arm (no output at all) is empty, not unpriced", () => {
		// A cell with zero OK samples produced no tokens, so calling it "unpriced"
		// would be wrong — there is simply nothing to price. It must not trip the
		// unpriced path and must not emit the loud note on its own.
		const s = summarizeCell([res({ error: "boom", outputTokens: null, costUsd: null })]);
		expect(costIsUnpriced(s)).toBe(false);
	});

	test("the summary and per-task tables render `unpriced`/`—`, never `$0.000`", () => {
		// End to end: an unpriced run must never show a fabricated dollar amount in
		// either table. This is the regression that the silent `$0.000` created.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 3; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000, costUsd: 0 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800, costUsd: 0 }));
		}
		const report = renderReport(results, "google-antigravity/gemini-3.5-flash", STAMP, 1);
		expect(report).not.toContain("$0.000");
		expect(report).toContain("| unpriced |"); // the per-arm totals cost cell
		expect(report).toContain("Cost is `unpriced` for at least one arm.");
	});

	test("the efficiency cost row says `unpriced`, coherent with the per-arm totals table", () => {
		// The coherence contract: a reader must not see `unpriced` in the totals table
		// and a differently-worded blank in the efficiency table for the SAME fact. The
		// cost metric with no signal reads `cost unpriced`, not the generic token-metric
		// wording, so both sections tell one story.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 3; i++) {
			results.push(
				res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000, inputTokens: 500, costUsd: 0 }),
			);
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800, inputTokens: 700, costUsd: 0 }));
		}
		const report = renderReport(results, "google-antigravity/gemini-3.5-flash", STAMP, 1);
		expect(report).toContain("cost unpriced — provider reported no price");
		// The token metrics DID have signal here, so they must NOT borrow the cost wording.
		expect(report).not.toContain("output tok | — | — | — | — | — | — | — | not measured");
	});

	test("a priced run keeps its dollars and emits no unpriced note", () => {
		// The guard against over-firing: when the provider DID price the run, the
		// report shows dollars and never prints the unpriced explanation.
		const results: ArmResult[] = [];
		for (let i = 1; i <= 3; i++) {
			results.push(res({ arm: "decode", task: `t${i}`, reward: 1, outputTokens: 1000, costUsd: 0.2 }));
			results.push(res({ arm: "full", task: `t${i}`, reward: 1, outputTokens: 800, costUsd: 0.15 }));
		}
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("$0.600"); // decode sum: 3 × 0.2
		expect(report).not.toContain("Cost is `unpriced`");
	});
});
