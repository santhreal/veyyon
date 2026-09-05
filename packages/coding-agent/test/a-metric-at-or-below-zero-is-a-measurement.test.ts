/**
 * WHY: the segment math read a run's metric as unmeasured when it was not
 * positive. That was a stand-in for "the placeholder zero a crash logs", and it
 * excluded two things that are not placeholders at all: a session minimising
 * `failures` whose kept run reached zero, which is the goal and was never tagged
 * best, and a signed metric such as a delta or a score whose best runs are
 * negative, which the Best row, the keep gate in `log_experiment`, the
 * confidence figure and the Trend row all treated as absent.
 *
 * The class is a placeholder recognised by its value instead of by its
 * provenance. The one fact that distinguishes a placeholder is the status it
 * was logged under and what the harness itself printed, and `measuredMetric` is
 * the single read every surface goes through, so the sweep below runs each
 * status the store can hand back through Best, confidence and the trend with a
 * zero and a negative metric and asserts the same answer at every surface.
 *
 * What it does not catch: a loop that logs zero on a `discard` because the
 * harness printed nothing. That number is logged on purpose under a status that
 * measures, so it is a measurement here; whether the loop should have written
 * it is the prompt's business.
 */
import { describe, expect, it } from "bun:test";
import { renderRunDetail } from "@veyyon/coding-agent/autoresearch/screen";
import {
	computeConfidence,
	createExperimentState,
	createSessionRuntime,
	findBestKeptResult,
	measuredMetric,
} from "@veyyon/coding-agent/autoresearch/state";
import {
	type AutoresearchRuntime,
	EXPERIMENT_STATUSES,
	type ExperimentResult,
	type ExperimentStatus,
	type MetricDirection,
} from "@veyyon/coding-agent/autoresearch/types";
import { stripAnsi } from "@veyyon/utils";
import { useTruecolorTheme } from "./helpers/theme-assertions";

const BLOCKS = "▁▂▃▄▅▆▇█";
const GAP = "·";

/**
 * Whether a status's logged number is a measurement. `crash` logs the number
 * the tool requires of it whether or not it measured, so it is the one status
 * whose measurement is what the harness printed instead. Keyed on the union so
 * a new status fails to compile until it is classified, and the sweep below
 * checks the keys against the product's own list.
 */
const LOGGED_NUMBER_MEASURES: Readonly<Record<ExperimentStatus, boolean>> = {
	keep: true,
	discard: true,
	checks_failed: true,
	crash: false,
};

function result(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
	return {
		runNumber: 1,
		commit: "abcdef1234567890",
		metric: 3,
		measuredPrimary: 3,
		metrics: {},
		status: "keep",
		description: "fixed a flaky assertion",
		timestamp: 0,
		segment: 0,
		confidence: null,
		modifiedPaths: [],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
		arm: null,
		certifiedBy: null,
		model: null,
		...overrides,
	};
}

function runtimeWith(results: readonly ExperimentResult[], direction: MetricDirection): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.metricName = "failures";
	runtime.state.metricUnit = "";
	runtime.state.bestDirection = direction;
	runtime.state.results = [...results];
	return runtime;
}

function trendRow(runtime: AutoresearchRuntime): string | undefined {
	const line = renderRunDetail(runtime, "session", 80)
		.map(stripAnsi)
		.find(candidate => candidate.startsWith("Trend"));
	return line?.slice("Trend".length).trim();
}

describe("a metric at or below zero is a measurement", () => {
	useTruecolorTheme("dark");

	it("classifies every status the store can hand back", () => {
		expect(Object.keys(LOGGED_NUMBER_MEASURES).sort()).toEqual([...EXPERIMENT_STATUSES].sort());
	});

	it("reads a zero and a negative logged number as measured on every status that measures", () => {
		for (const [status, measures] of Object.entries(LOGGED_NUMBER_MEASURES) as [ExperimentStatus, boolean][]) {
			for (const metric of [0, -4.5]) {
				// The harness printed nothing, so the logged number is all there is.
				const run = result({ status, metric, measuredPrimary: null });
				expect(measuredMetric(run)).toBe(measures ? metric : null);
				// The harness printed the same number: measured under every status.
				expect(measuredMetric(result({ status, metric, measuredPrimary: metric }))).toBe(metric);
			}
		}
	});

	it("tags the run that reached zero as best where lower is better", () => {
		// The whole defect: a session minimising failures gets to zero and the
		// ledger keeps pointing at the run before it.
		const results = [
			result({ runNumber: 1, metric: 3, measuredPrimary: 3 }),
			result({ runNumber: 2, metric: 1, measuredPrimary: 1 }),
			result({ runNumber: 3, metric: 0, measuredPrimary: 0 }),
		];
		expect(findBestKeptResult(results, 0, "lower")?.runNumber).toBe(3);
	});

	it("ranks negative measurements by direction rather than dropping them", () => {
		const results = [
			result({ runNumber: 1, metric: -1, measuredPrimary: -1 }),
			result({ runNumber: 2, metric: -6, measuredPrimary: -6 }),
			result({ runNumber: 3, metric: -3, measuredPrimary: -3 }),
		];
		expect(findBestKeptResult(results, 0, "lower")?.runNumber).toBe(2);
		expect(findBestKeptResult(results, 0, "higher")?.runNumber).toBe(1);
	});

	it("still skips a crash whose only number is the placeholder", () => {
		// Ordering: the crash's logged zero would be the best value of a
		// lower-is-better segment if it were read as a measurement. A crash is
		// never kept, so Best cannot pick it; confidence and the trend can.
		const results = [
			result({ runNumber: 1, metric: 5, measuredPrimary: 5 }),
			result({ runNumber: 2, metric: 4, measuredPrimary: 4 }),
			result({ runNumber: 3, metric: 0, measuredPrimary: null, status: "crash" }),
		];
		// Two measurements are below the confidence floor of three: the crash's
		// zero must not be the third.
		expect(computeConfidence(results, 0, "lower")).toBeNull();
		expect(trendRow(runtimeWith(results, "lower"))).toBeUndefined();
	});

	it("counts a zero and a negative measurement toward confidence", () => {
		// Three real measurements through zero: a noise floor exists and the best
		// kept run differs from the baseline, so the figure is a number.
		const results = [
			result({ runNumber: 1, metric: 2, measuredPrimary: 2 }),
			result({ runNumber: 2, metric: 0, measuredPrimary: 0 }),
			result({ runNumber: 3, metric: -2, measuredPrimary: -2 }),
		];
		const confidence = computeConfidence(results, 0, "lower");
		expect(confidence).not.toBeNull();
		// |best - baseline| / MAD = |-2 - 2| / 2.
		expect(confidence).toBe(2);
	});

	it("draws a zero and a negative measurement as heights in the trend, not gaps", () => {
		const row = trendRow(
			runtimeWith(
				[
					result({ runNumber: 1, metric: 2, measuredPrimary: 2 }),
					result({ runNumber: 2, metric: 0, measuredPrimary: 0 }),
					result({ runNumber: 3, metric: -2, measuredPrimary: -2 }),
					result({ runNumber: 4, metric: 0, measuredPrimary: null, status: "crash" }),
				],
				"lower",
			),
		);
		expect(row).toBeDefined();
		const cells = [...(row ?? "")];
		expect(cells).toHaveLength(4);
		for (const cell of cells.slice(0, 3)) expect(BLOCKS).toContain(cell);
		expect(cells[3]).toBe(GAP);
		const heights = cells.slice(0, 3).map(cell => BLOCKS.indexOf(cell));
		expect(heights[1]).toBeLessThan(heights[0]);
		expect(heights[2]).toBeLessThan(heights[1]);
	});

	it("names the run that reached zero as best in the session pane", () => {
		const runtime = runtimeWith(
			[
				result({ runNumber: 1, metric: 3, measuredPrimary: 3 }),
				result({ runNumber: 2, metric: 0, measuredPrimary: 0, description: "removed the race" }),
			],
			"lower",
		);
		const best = renderRunDetail(runtime, "session", 80)
			.map(stripAnsi)
			.find(line => line.startsWith("Best"));
		expect(best).toBeDefined();
		expect(best).toContain("run 2");
	});
});
