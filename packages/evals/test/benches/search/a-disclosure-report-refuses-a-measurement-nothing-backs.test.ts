/**
 * WHY: the disclosure bench derived every number it printed from what the full search inlined, and
 * divided by that byte count without looking at it. A run whose search inlined nothing reported
 * `NaN%` saved, and a run whose search reported no counts printed "0 matches across 0 files" — a
 * measurement nothing made, formatted as a result. The bench's own exit code reads
 * `inlineReductionBytes`, so a NaN percentage shipped as a pass.
 *
 * The class this closes: a derived statistic computed from an absent or empty measurement. Every
 * input the report divides by, or reports as a count, is swept for its absent and zero case, and the
 * arithmetic is pinned so a rounding or projection change is visible. The refusals live in
 * `buildSearchDisclosureReport`, the one place the report is derived, so they cover the bench entry
 * point and any later caller of the same builder.
 *
 * One mutation stays green and is equivalent rather than uncovered: dropping `Math.round` around the
 * token estimate. The projection multiplies by 60 later turns, 60 is a multiple of 4, and the
 * estimate divides by 4 bytes per token, so the quotient is always an integer. Raising or lowering
 * `ASSUMED_LATER_TURNS` to a value that is not a multiple of 4 makes the rounding observable again.
 *
 * WHAT THIS DOES NOT CATCH: whether the search tool measures the right corpus — the sibling suite
 * `progressive-disclosure-holds-a-search-answer-to-its-budget.test.ts` drives the real corpus end to
 * end. A search that inlines one byte is a measurement, however useless, and is reported.
 */
import { describe, expect, it } from "bun:test";
import {
	buildSearchDisclosureReport,
	formatSearchDisclosureBenchmark,
	type SearchDisclosureMeasurement,
} from "../../../src/benches/search/disclosure";

const MEASURED: SearchDisclosureMeasurement = {
	fileCount: 20,
	matchCount: 160,
	fullInlineBytes: 1000,
	compactInlineBytes: 250,
	artifactBytes: 1000,
	exactRecovery: true,
};

const REFUSALS = [
	["no file count", { fileCount: null }, "reported no file or match count"],
	["no match count", { matchCount: null }, "reported no file or match count"],
	["neither count", { fileCount: null, matchCount: null }, "reported no file or match count"],
	["no matches", { matchCount: 0 }, "the corpus at /corpus/disclosure produced no matches"],
	["no inlined bytes", { fullInlineBytes: 0 }, "inlined no bytes, so there is no reduction"],
	["a negative byte count", { fullInlineBytes: -1 }, "inlined no bytes, so there is no reduction"],
] as [string, Partial<SearchDisclosureMeasurement>, string][];

describe("a disclosure report refuses a measurement nothing backs", () => {
	it.each(REFUSALS)("refuses %s", (_label, override, message) => {
		expect(() => buildSearchDisclosureReport({ ...MEASURED, ...override }, "/corpus/disclosure")).toThrow(message);
	});

	it("derives the reduction, the projection and the token estimate from what it measured", () => {
		const report = buildSearchDisclosureReport(MEASURED, "/corpus/disclosure");

		expect(report).toEqual({
			fileCount: 20,
			matchCount: 160,
			fullInlineBytes: 1000,
			compactInlineBytes: 250,
			artifactBytes: 1000,
			exactRecovery: true,
			inlineReductionBytes: 750,
			inlineReductionPercent: 75,
			assumedLaterTurns: 60,
			estimatedByteTurnsAvoided: 45000,
			estimatedTokensAvoided: 11250,
		});
	});

	it("rounds the percentage to two places instead of printing its full expansion", () => {
		const report = buildSearchDisclosureReport({ ...MEASURED, fullInlineBytes: 3, compactInlineBytes: 2 }, "c");

		expect(report.inlineReductionPercent).toBe(33.33);
		expect(formatSearchDisclosureBenchmark(report)).toContain("1 bytes (33.33%)");
	});

	it("reports a compact result that grew as the negative saving it is", () => {
		const report = buildSearchDisclosureReport({ ...MEASURED, compactInlineBytes: 1200 }, "c");

		expect(report.inlineReductionBytes).toBe(-200);
		expect(report.inlineReductionPercent).toBe(-20);
		expect(report.estimatedTokensAvoided).toBe(-3000);
	});

	it("names the counts it measured in the summary it prints", () => {
		const summary = formatSearchDisclosureBenchmark(buildSearchDisclosureReport(MEASURED, "c"));

		expect(summary).toContain("Corpus:                 160 matches across 20 files");
		expect(summary).toContain("Est. tokens avoided:    11250");
		expect(summary).not.toContain("NaN");
	});
});
