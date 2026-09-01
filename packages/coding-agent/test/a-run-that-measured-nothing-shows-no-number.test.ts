/**
 * WHY: `log_experiment` requires a metric on every status, so a run that crashed
 * before it measured anything is logged with the only number available — zero.
 * The screen formatted that like any other value, so a session where lower is
 * better listed `#6  0ms` above every real result: the fastest-looking row on the
 * screen was the run that segfaulted. The detail pane went further and computed a
 * percentage against the baseline, printing `0ms  -100.0%` about a run that
 * produced no measurement at all.
 *
 * Suppressing every crash's number overshoots in the other direction: a harness
 * that printed `205.94ms` and then died on teardown did measure, and that number
 * is what the run is worth reading for. The store keeps what the harness itself
 * printed, so the two cases are distinguishable and are distinguished here.
 *
 * The contract: a run reports the measurement its harness produced, and a run
 * whose harness produced none reports no measurement and no comparison — in the
 * sidebar and in the detail alike. The logged placeholder is never rendered as a
 * measurement.
 *
 * The class is a placeholder value formatted as data. The variant space is the
 * `ExperimentStatus` union, swept from the product's own statuses at run time
 * rather than from a list written here, so adding a status turns this red until
 * someone records whether it measures.
 *
 * What it does not catch: whether the loop SHOULD write zero. The tool's schema
 * requires a number and this is the display's side of that; a metric that becomes
 * nullable end to end would make this test's subject disappear rather than fail.
 */
import { describe, expect, it } from "bun:test";
import { metricLabel, renderRunDetail, runScreenRows } from "@veyyon/coding-agent/autoresearch/screen";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import {
	type AutoresearchRuntime,
	EXPERIMENT_STATUSES,
	type ExperimentResult,
	type ExperimentStatus,
} from "@veyyon/coding-agent/autoresearch/types";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/**
 * Every status a logged run can carry, and whether its logged `metric` is a
 * measurement.
 *
 * Read off `parseStatus`, which is the only gate a status passes through on its
 * way out of the store: a value it rejects never reaches a screen. Keeping the
 * map here rather than the list means a new status has to be classified, and the
 * sweep below fails until it is.
 *
 * `crash` is false because its logged number is the tool's required placeholder.
 * What a crashed run measured, if anything, is carried separately.
 */
const MEASURES: Readonly<Record<ExperimentStatus, boolean>> = {
	keep: true,
	discard: true,
	checks_failed: true,
	crash: false,
};

function result(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
	return {
		runNumber: 1,
		commit: "abcdef1234567890",
		metric: 0,
		measuredPrimary: null,
		metrics: {},
		status: "keep",
		description: "reused one arena across chunks",
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
		...overrides,
	};
}

/** A session with a baseline to compare against, plus one run of `status`. */
function runtimeWith(
	status: ExperimentStatus,
	metric: number,
	measuredPrimary: number | null = null,
): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.metricName = "wall time";
	runtime.state.metricUnit = "ms";
	runtime.state.bestDirection = "lower";
	runtime.state.results = [
		result({ runNumber: 1, metric: 205.94, measuredPrimary: 205.94, status: "keep", description: "baseline" }),
		result({ runNumber: 2, metric, measuredPrimary, status }),
	];
	return runtime;
}

describe("a run that measured nothing shows no number", () => {
	// The detail pane paints through the theme, so one has to be installed; the
	// assertions read text, not colour.
	useTruecolorTheme("dark");

	it("classifies every status the store can hand back", () => {
		// The product's own status array is the sweep's source, read at run time: a
		// status added to the union without a decision in MEASURES fails to compile
		// against `Record<ExperimentStatus, boolean>`, and one bolted on with a
		// looser type fails here instead of going unswept.
		expect(Object.keys(MEASURES).sort()).toEqual([...EXPERIMENT_STATUSES].sort());
	});

	it("names the outcome instead of a metric for a status whose number is a placeholder", () => {
		for (const [status, measures] of Object.entries(MEASURES) as [ExperimentStatus, boolean][]) {
			const label = metricLabel(result({ status, metric: 0, measuredPrimary: null }), "ms");
			if (measures) expect(label).toBe("0ms");
			else expect(label).toBe("no metric");
		}
	});

	it("reports a measurement the harness printed, whatever the status", () => {
		// Every status that measures reads its logged number; the one whose logged
		// number is a placeholder reads what the harness printed instead. Both are
		// "show the measurement that exists", which is the single rule under test.
		for (const status of Object.keys(MEASURES) as ExperimentStatus[]) {
			const measured = result({ status, metric: 0, measuredPrimary: 244.51 });
			const expected = MEASURES[status] ? "0ms" : "244.51ms";
			expect(metricLabel(measured, "ms")).toBe(expected);
		}
	});

	it("keeps the number out of the sidebar row of a crashed run", () => {
		const rows = runScreenRows(runtimeWith("crash", 0));
		const crashed = rows.find(row => row.value === "run:2");
		// No number and no percentage, and still a verdict: the row states the run
		// crashed rather than going blank next to the one that measured.
		expect(crashed?.label).toBe("#2  no metric  crash");
		// The measured run beside it still reports its number, so this is not a
		// blanket suppression.
		expect(rows.find(row => row.value === "run:1")?.label).toBe("#1  205.94ms   base");
	});

	it("keeps the number and the percentage out of a crashed run's detail", () => {
		const detail = renderRunDetail(runtimeWith("crash", 0), "run:2", 76).join("\n");
		expect(detail).toContain("no metric");
		expect(detail).not.toContain("0ms");
		expect(detail).not.toContain("%");
	});

	it("still reports a measured failure, which is a different thing", () => {
		// `checks_failed` measured the tree and then failed its tests: the number is
		// real, and it is what decides whether the idea was worth repairing.
		const detail = renderRunDetail(runtimeWith("checks_failed", 244.51, 244.51), "run:2", 76).join("\n");
		expect(detail).toContain("244.51ms");
		expect(detail).toContain("%");
		const rows = runScreenRows(runtimeWith("checks_failed", 244.51, 244.51));
		expect(rows.find(row => row.value === "run:2")?.label).toBe("#2  244.51ms  +18.7%  fail");
	});

	it("reports a crash that measured before it died", () => {
		// The harness printed 244.51ms and the process died on teardown. The logged
		// metric is still the required placeholder, so a screen that reads `metric`
		// prints 0ms and a screen that suppresses every crash prints nothing; both hide
		// the one number the run produced.
		const runtime = runtimeWith("crash", 0, 244.51);
		expect(runScreenRows(runtime).find(row => row.value === "run:2")?.label).toBe("#2  244.51ms  +18.7%  crash");
		const detail = renderRunDetail(runtime, "run:2", 76).join("\n");
		expect(detail).toContain("244.51ms");
		// It is still a crash: the outcome states it, and the comparison it prints is
		// against the measurement, not against the placeholder.
		expect(detail).toContain("crash");
		expect(detail).toContain("+18.7%");
		expect(detail).not.toContain("0ms");
	});

	it("does not let a crash become the best or the baseline", () => {
		// The math already skipped a non-keep status, and the frame that exposed the
		// display defect is the one where a 0ms row sat above every real result: if
		// this ever regresses, the screen reports a segfault as the best arm.
		const runtime = runtimeWith("crash", 0);
		const session = renderRunDetail(runtime, "session", 76).join("\n");
		expect(session).toContain("205.94ms");
		expect(session).not.toContain("0ms");
	});
});
