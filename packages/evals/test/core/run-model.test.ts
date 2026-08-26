/**
 * Tests for EvalRunRecord construction and the cross-suite refusal invariant.
 *
 * Invariant: Cross-suite comparison is strictly refused. Pass rates and metrics
 * from different evaluation suites may never share a table or aggregate run.
 */

import { describe, expect, it } from "bun:test";
import {
	assertSameSuite,
	CrossSuiteComparisonError,
	createRunComparisonTable,
	createRunRecord,
	type EvalRunRecord,
	InvalidRunRecordError,
	mergeRunRecords,
	summarizeRunCells,
	type TrialResultRecord,
} from "../../src/core/run-model";

function createSampleRun(
	id: string,
	suiteName: string,
	suiteVersion = "1.0.0",
	variants = ["baseline", "candidate"],
	results: TrialResultRecord[] = [],
): EvalRunRecord {
	return createRunRecord({
		id,
		suite: {
			name: suiteName,
			version: suiteVersion,
			provenanceSha: "sha-abc",
		},
		variants: variants.map(name => ({
			name,
			harness: "veyyon",
			configPath: `arms/${name}.yml`,
			promptVariantPath: null,
			model: "anthropic/claude-sonnet",
			attachments: [],
		})),
		tasks: ["task-1", "task-2"],
		repeats: 1,
		results,
	});
}

describe("createRunRecord", () => {
	it("creates a well-formed EvalRunRecord", () => {
		const run = createSampleRun("run-001", "deep-swe", "2.0.0");
		expect(run.id).toBe("run-001");
		expect(run.suite.name).toBe("deep-swe");
		expect(run.suite.version).toBe("2.0.0");
		expect(run.variants.length).toBe(2);
		expect(run.tasks).toEqual(["task-1", "task-2"]);
		expect(run.repeats).toBe(1);
	});

	it("refuses a record that cannot identify itself or its suite", () => {
		expect(() => createSampleRun("", "deep-swe")).toThrow(InvalidRunRecordError);
		expect(() => createSampleRun("run-x", "")).toThrow(InvalidRunRecordError);
		expect(() => createSampleRun("run-x", "deep-swe", "")).toThrow(InvalidRunRecordError);
	});
});

describe("Cross-suite comparison refusal invariant", () => {
	it("allows same-suite runs in assertSameSuite", () => {
		const run1 = createSampleRun("run-1", "deep-swe", "1.0");
		const run2 = createSampleRun("run-2", "deep-swe", "1.1");
		expect(() => assertSameSuite([run1, run2])).not.toThrow();
	});

	it("strictly throws CrossSuiteComparisonError when comparing runs from different suites", () => {
		const deepSweRun = createSampleRun("run-deep", "deep-swe");
		const terminalBenchRun = createSampleRun("run-tb3", "terminal-bench");

		expect(() => assertSameSuite([deepSweRun, terminalBenchRun])).toThrow(CrossSuiteComparisonError);

		try {
			assertSameSuite([deepSweRun, terminalBenchRun]);
		} catch (err) {
			const crossErr = err as CrossSuiteComparisonError;
			expect(crossErr.name).toBe("CrossSuiteComparisonError");
			expect(crossErr.suiteA).toBe("deep-swe");
			expect(crossErr.suiteB).toBe("terminal-bench");
			expect(crossErr.message).toContain("deep-swe");
			expect(crossErr.message).toContain("terminal-bench");
			expect(crossErr.message).toContain("Pass rates from different suites may never share a table");
		}
	});

	it("refuses cross-suite table generation in createRunComparisonTable", () => {
		const runA = createSampleRun("run-a", "deep-swe");
		const runB = createSampleRun("run-b", "terminal-bench");

		expect(() => createRunComparisonTable([runA, runB])).toThrow(CrossSuiteComparisonError);
	});

	it("creates a comparison table for same-suite runs", () => {
		const resultsA: TrialResultRecord[] = [
			{
				cell: { variant: "baseline", suite: "deep-swe", task: "task-1", repeat: 1 },
				score: {
					reward: 1,
					partial: null,
					error: null,
					usage: { costUsd: 0.05, inputTokens: 100, outputTokens: 200 },
					extra: {},
				},
			},
		];

		const runA = createSampleRun("run-a", "deep-swe", "1.0.0", ["baseline"], resultsA);
		const runB = createSampleRun("run-b", "deep-swe", "1.0.0", ["baseline"]);

		const table = createRunComparisonTable([runA, runB]);
		expect(table.suiteName).toBe("deep-swe");
		expect(table.runs.length).toBe(2);
		expect(table.runs[0].variants[0].passRate).toBe(1);
		expect(table.runs[0].variants[0].totalCostUsd).toBe(0.05);
	});

	it("refuses merging runs from different suites", () => {
		const run1 = createSampleRun("run-1", "deep-swe");
		const run2 = createSampleRun("run-2", "typescript-edit");

		expect(() => mergeRunRecords([run1, run2])).toThrow(CrossSuiteComparisonError);
	});

	it("merges valid same-suite runs into a single combined record", () => {
		const results1: TrialResultRecord[] = [
			{
				cell: { variant: "baseline", suite: "deep-swe", task: "task-1", repeat: 1 },
				score: { reward: 1, partial: null, error: null, usage: null, extra: {} },
			},
		];
		const results2: TrialResultRecord[] = [
			{
				cell: { variant: "baseline", suite: "deep-swe", task: "task-2", repeat: 1 },
				score: { reward: 0, partial: null, error: null, usage: null, extra: {} },
			},
		];

		const run1 = createSampleRun("run-1", "deep-swe", "1.0.0", ["baseline"], results1);
		const run2 = createSampleRun("run-2", "deep-swe", "1.0.0", ["baseline"], results2);

		const merged = mergeRunRecords([run1, run2], "merged-run");
		expect(merged.id).toBe("merged-run");
		expect(merged.suite.name).toBe("deep-swe");
		expect(merged.results.length).toBe(2);
		expect(merged.tasks).toEqual(["task-1", "task-2"]);
	});
});

describe("summarizeRunCells", () => {
	// This block previously pinned the defect: a trial that never reached the grader sat in the
	// denominator of passRate and meanReward, so a run whose trials crashed reported a low score
	// instead of an unmeasured one, and unmeasured tokens read as 0. The expectations below are
	// the corrected contract from core/scoring.ts.
	it("excludes an infrastructure error from every rate and reports it beside them", () => {
		const results: TrialResultRecord[] = [
			{
				cell: { variant: "v1", suite: "suite-a", task: "t1", repeat: 1 },
				score: {
					reward: 1,
					partial: 0.8,
					error: null,
					usage: { costUsd: 0.1, inputTokens: 50, outputTokens: 100 },
					extra: {},
				},
			},
			{
				cell: { variant: "v1", suite: "suite-a", task: "t2", repeat: 1 },
				score: {
					reward: 0,
					partial: 0.2,
					error: null,
					usage: { costUsd: 0.15, inputTokens: 60, outputTokens: 120 },
					extra: {},
				},
			},
			{
				cell: { variant: "v1", suite: "suite-a", task: "t3", repeat: 1 },
				score: {
					reward: null,
					partial: null,
					error: "container exited before the grader ran",
					usage: { costUsd: 0.02, inputTokens: 5, outputTokens: 7 },
					extra: {},
				},
			},
		];

		const run = createSampleRun("run-summ", "suite-a", "1.0", ["v1"], results);
		const s = summarizeRunCells(run)[0];

		expect(s.variant).toBe("v1");
		expect(s.total).toBe(3);
		expect(s.scored).toBe(2);
		expect(s.timedOut).toBe(0);
		expect(s.errors).toBe(1);
		expect(s.denominator).toBe(2);
		expect(s.passes).toBe(1);
		expect(s.passRate).toBeCloseTo(1 / 2, 6);
		expect(s.meanReward).toBeCloseTo(1 / 2, 6);
		expect(s.meanPartial).toBeCloseTo(1 / 2, 6);
		// Spend and tokens cover the errored trial too: the provider billed for the work it did.
		expect(s.totalCostUsd).toBeCloseTo(0.27, 6);
		expect(s.totalInputTokens).toBe(115);
		expect(s.totalOutputTokens).toBe(227);
	});

	it("grades a timed-out trial as a zero inside the denominator", () => {
		const results: TrialResultRecord[] = [
			{
				cell: { variant: "v1", suite: "suite-a", task: "t1", repeat: 1 },
				score: { reward: 1, partial: 1, error: null, usage: null, extra: {} },
			},
			{
				cell: { variant: "v1", suite: "suite-a", task: "t2", repeat: 1 },
				score: { reward: null, partial: null, error: "agent budget exhausted", usage: null, extra: {} },
				artifacts: { extra: { timedOut: true } },
			},
		];

		const run = createSampleRun("run-timeout", "suite-a", "1.0", ["v1"], results);
		const s = summarizeRunCells(run)[0];

		expect(s.timedOut).toBe(1);
		expect(s.errors).toBe(0);
		expect(s.scored).toBe(1);
		expect(s.denominator).toBe(2);
		expect(s.passes).toBe(1);
		expect(s.passRate).toBeCloseTo(0.5, 6);
		expect(s.meanReward).toBeCloseTo(0.5, 6);
		// Nothing measured a cost, so the cell reports no spend rather than free work.
		expect(s.totalCostUsd).toBeNull();
		expect(s.totalInputTokens).toBeNull();
	});

	it("reports no rate at all when every trial failed before the grader", () => {
		const results: TrialResultRecord[] = [1, 2].map(n => ({
			cell: { variant: "v1", suite: "suite-a", task: `t${n}`, repeat: 1 },
			score: { reward: null, partial: null, error: "backend refused the trial", usage: null, extra: {} },
		}));

		const run = createSampleRun("run-dead", "suite-a", "1.0", ["v1"], results);
		const s = summarizeRunCells(run)[0];

		expect([s.total, s.errors, s.denominator]).toEqual([2, 2, 0]);
		expect(s.passRate).toBeNull();
		expect(s.meanReward).toBeNull();
		expect(s.meanPartial).toBeNull();
	});
});
