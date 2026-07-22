import { describe, expect, it } from "bun:test";
import {
	currentResults,
	findBaselineResult,
	findBaselineSecondary,
	sortedMedian,
} from "@veyyon/coding-agent/autoresearch/state";
import type { ExperimentResult, ExperimentStatus } from "@veyyon/coding-agent/autoresearch/types";

function result(overrides: Partial<ExperimentResult>): ExperimentResult {
	return {
		runNumber: 1,
		commit: "c",
		metric: 0,
		metrics: {},
		status: "keep",
		description: "",
		timestamp: 0,
		segment: 0,
		confidence: null,
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
		...overrides,
	};
}

/**
 * sortedMedian is the summary statistic used across the autoresearch dashboard to collapse repeated
 * measurements of one experiment into a single robust number. It sorts a COPY, averages the two middle
 * values on an even count, and returns 0 for an empty set. These are the exact places a median goes
 * wrong: an even-length off-by-one (picking one middle instead of the average), mutating the caller's
 * array as a side effect, or throwing on empty input.
 */
describe("sortedMedian", () => {
	it("returns 0 for an empty set rather than NaN or a throw", () => {
		expect(sortedMedian([])).toBe(0);
	});

	it("returns the single value for a one-element set", () => {
		expect(sortedMedian([5])).toBe(5);
	});

	it("returns the middle element for an odd count, regardless of input order", () => {
		expect(sortedMedian([3, 1, 2])).toBe(2);
	});

	it("averages the two middle values for an even count", () => {
		expect(sortedMedian([4, 1, 3, 2])).toBe(2.5);
		expect(sortedMedian([1, 2])).toBe(1.5);
	});

	it("handles negatives and floats", () => {
		expect(sortedMedian([-5, -1, -3])).toBe(-3);
		expect(sortedMedian([1.5, 2.5, 0.5])).toBe(1.5);
	});

	it("does not mutate the caller's array (sorts a copy)", () => {
		const input = [9, 1, 5];
		sortedMedian(input);
		expect(input).toEqual([9, 1, 5]);
	});
});

/**
 * currentResults / findBaselineResult / findBaselineSecondary select the comparison baseline for the
 * current experiment segment. A wrong pick corrupts every relative-improvement number the dashboard
 * shows: the baseline must be the FIRST kept, non-flagged run in the SAME segment, and secondary
 * metrics missing from that baseline are back-filled from the first non-flagged run that has them
 * (flagged runs are never a source, because a flagged run's numbers are suspect).
 */
describe("currentResults", () => {
	it("keeps only results in the requested segment, preserving order", () => {
		const results = [
			result({ commit: "a", segment: 0 }),
			result({ commit: "b", segment: 1 }),
			result({ commit: "c", segment: 0 }),
		];
		expect(currentResults(results, 0).map(r => r.commit)).toEqual(["a", "c"]);
		expect(currentResults(results, 1).map(r => r.commit)).toEqual(["b"]);
	});
});

describe("findBaselineResult", () => {
	it("returns the first kept, non-flagged result in the segment, skipping discarded and flagged runs", () => {
		const results = [
			result({ commit: "discarded", segment: 0, status: "discard" as ExperimentStatus }),
			result({ commit: "flagged", segment: 0, flagged: true }),
			result({ commit: "good", segment: 0 }),
			result({ commit: "good2", segment: 0 }),
		];
		expect(findBaselineResult(results, 0)?.commit).toBe("good");
	});

	it("ignores kept runs from other segments", () => {
		const results = [result({ commit: "other", segment: 1 })];
		expect(findBaselineResult(results, 0)).toBeNull();
	});

	it("returns null when no kept, non-flagged result exists in the segment", () => {
		const results = [result({ commit: "flagged", segment: 0, flagged: true })];
		expect(findBaselineResult(results, 0)).toBeNull();
	});
});

describe("findBaselineSecondary", () => {
	it("uses the baseline's own metrics and back-fills the rest from non-flagged runs", () => {
		const knownMetrics = [
			{ name: "lat", unit: "ms" },
			{ name: "mem", unit: "mb" },
			{ name: "cpu", unit: "%" },
		];
		const results = [
			result({ commit: "base", segment: 0, metrics: { lat: 10 } }), // baseline provides lat
			result({ commit: "flagged", segment: 0, flagged: true, metrics: { mem: 999, cpu: 5 } }), // never a source
			result({ commit: "filler", segment: 0, metrics: { mem: 20 } }), // provides mem
			result({ commit: "filler2", segment: 0, metrics: { mem: 30, cpu: 7 } }), // first non-flagged with cpu
		];
		// lat from baseline; mem from the first non-flagged run that has it (20, NOT the flagged 999);
		// cpu from filler2 (7, NOT the flagged 5).
		expect(findBaselineSecondary(results, 0, knownMetrics)).toEqual({ lat: 10, mem: 20, cpu: 7 });
	});

	it("leaves a metric absent when no non-flagged run in the segment reports it", () => {
		const knownMetrics = [{ name: "unreported", unit: "x" }];
		const results = [result({ commit: "base", segment: 0, metrics: { lat: 1 } })];
		expect(findBaselineSecondary(results, 0, knownMetrics)).toEqual({ lat: 1 });
	});
});
