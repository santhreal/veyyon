/**
 * WHY: the run list is read by scanning it, and it used to be unscannable. Every
 * row was a number and a metric; what the run was WORTH lived in the item's
 * description, and `SelectList` drops descriptions below 41 columns while the
 * sidebar is capped well under that. The outcome, the arm and the change against
 * the baseline were computed, carried through storage, handed to the component
 * and then rendered nowhere. An operator four iterations into a swarm could not
 * identify which row won, which row was the reference, or which arm produced either.
 *
 * The contract: a row states its own verdict. Which run it was and which arm ran
 * it, what it measured, how that compares to the baseline of ITS OWN segment,
 * and what it is worth — in the label, which is the part that renders, and
 * padded into columns that stay put as the list grows.
 *
 * Three classes are closed here. The first is a status the row cannot describe:
 * the sweep is over `EXPERIMENT_STATUSES` at run time, and a member added
 * without a tag turns this red rather than falling through to `kept`. The second
 * is a column that sheds out of order or overflows: the ladder is asserted
 * across every sidebar width the screen can produce, including the widths where
 * a segment has no percentage to print at all. The third is a `best` tag that
 * disagrees with the pane beside it, which is what three separate best-finders
 * produced on a segment holding a run logged with the placeholder zero.
 *
 * What it does not catch: colour. Every assertion runs through a passthrough
 * theme, because a row that is the right text in the wrong paint is a palette
 * defect and the theme owns that.
 */
import { describe, expect, it } from "bun:test";
import { formatNum } from "@veyyon/coding-agent/autoresearch/helpers";
import { renderRunDetail, runScreenRows, screenSidebarWidth } from "@veyyon/coding-agent/autoresearch/screen";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import {
	type AutoresearchRuntime,
	EXPERIMENT_STATUSES,
	type ExperimentResult,
	type ExperimentStatus,
} from "@veyyon/coding-agent/autoresearch/types";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/**
 * The tag every status renders as, keyed by the status itself so a new member of
 * the union arrives here as a missing key rather than as a silent `kept`.
 *
 * `keep` is the only status whose tag is decided by the run's ROLE — a kept run
 * is the baseline, or the best, or neither — so it is the only one that maps to
 * the fallback.
 */
const TAG_FOR: Readonly<Record<ExperimentStatus, string>> = {
	keep: "kept",
	discard: "drop",
	crash: "crash",
	checks_failed: "fail",
};

function result(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
	return {
		runNumber: 1,
		commit: "abcdef1234567890",
		metric: 200,
		measuredPrimary: 200,
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

function runtimeWith(results: readonly ExperimentResult[]): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.metricName = "wall time";
	runtime.state.metricUnit = "ms";
	runtime.state.bestDirection = "lower";
	runtime.state.results = [...results];
	return runtime;
}

/** The label of one run row, which is the only part of an item that renders. */
function labelOf(runtime: AutoresearchRuntime, runNumber: number, sidebarWidth?: number): string {
	const rows = runScreenRows(runtime, sidebarWidth);
	const row = rows.find(candidate => candidate.value === `run:${runNumber}`);
	if (row === undefined) throw new Error(`no row for run ${runNumber}`);
	return row.label;
}

/** Every sidebar width the screen can hand this function, narrowest first. */
function reachableSidebarWidths(): number[] {
	const widths = new Set<number>();
	for (let terminal = 20; terminal <= 400; terminal += 1) widths.add(screenSidebarWidth(terminal));
	return [...widths].sort((a, b) => a - b);
}

describe("a run row states its own verdict", () => {
	useTruecolorTheme("dark");

	it("has a tag for every status the store can hand back", () => {
		// The decision table and the union are the same set, so adding a status
		// without a decision on what its row states fails here and not in a screenshot.
		expect(Object.keys(TAG_FOR).sort()).toEqual([...EXPERIMENT_STATUSES].sort());
	});

	it("tags each status distinctly, on a run that is neither baseline nor best", () => {
		// Run #1 is the baseline and the leader, so run #2's tag comes from its
		// status alone. A new status that fell through to the role fallback would
		// read `kept` here, which is the failure the distinctness check catches.
		for (const status of EXPERIMENT_STATUSES) {
			const runtime = runtimeWith([
				result({ runNumber: 1, metric: 100, measuredPrimary: 100 }),
				result({ runNumber: 2, metric: 300, measuredPrimary: 300, status }),
			]);
			expect(labelOf(runtime, 2)).toContain(TAG_FOR[status]);
		}
		const tags = Object.values(TAG_FOR);
		expect(new Set(tags).size).toBe(tags.length);
	});

	it("tags the run the detail pane calls best, on a segment holding an unmeasured zero", () => {
		// Three surfaces report a best: this row's tag, the session pane's Best row,
		// and the status row. They were three scans, two of which admitted the
		// placeholder zero a run that never measured is logged with and one of
		// which did not. Where lower is better that zero is the best value there
		// is, so a kept run that measured nothing took the tag in the ledger while
		// the pane beside it named a different run.
		//
		// Run 3 is `keep`, which is what makes it the divergent case: `crash` is
		// excluded by status before the metric is looked at, so a corpus whose
		// unmeasured run crashed passes under either rule.
		const runtime = runtimeWith([
			result({ runNumber: 1, metric: 300, measuredPrimary: 300 }),
			result({ runNumber: 2, metric: 150, measuredPrimary: 150 }),
			result({ runNumber: 3, metric: 0, measuredPrimary: null }),
		]);
		expect(labelOf(runtime, 2)).toContain("best");
		expect(labelOf(runtime, 3)).not.toContain("best");
		// And the pane agrees, by run number rather than by metric: the tag and the
		// row have to name one run, not two runs that happen to share a number.
		const pane = renderRunDetail(runtime, "session", 80).map(stripAnsi);
		const bestRow = pane.find(line => line.startsWith("Best")) ?? "";
		expect(bestRow).toContain("run 2");
	});

	it("says a run is flagged before it says what the run was", () => {
		// A flagged run is out of the baseline and out of the best, so its status
		// is the less useful of the two facts and the row leads with the exclusion.
		// Swept over every status a flagged run can carry, because precedence
		// checked on one of them holds for one of them.
		for (const status of EXPERIMENT_STATUSES) {
			const runtime = runtimeWith([
				result({ runNumber: 1, metric: 100, measuredPrimary: 100 }),
				result({
					runNumber: 2,
					metric: 50,
					measuredPrimary: 50,
					status,
					flagged: true,
					flaggedReason: "edited the harness",
				}),
			]);
			expect(labelOf(runtime, 2)).toContain("flag");
			expect(labelOf(runtime, 2)).not.toContain(TAG_FOR[status]);
		}
	});

	it("calls the run that is both the baseline and the leader the baseline", () => {
		// Early in a segment nothing has beaten the start. Tagging that row `best`
		// puts a winner on a list that has not produced one; with no row tagged
		// `best`, the absence is the reading and it is the true one.
		const alone = runtimeWith([result({ runNumber: 1, metric: 100, measuredPrimary: 100 })]);
		expect(labelOf(alone, 1)).toContain("base");
		expect(labelOf(alone, 1)).not.toContain("best");

		// Once something does beat it, the two roles separate onto two rows.
		const beaten = runtimeWith([
			result({ runNumber: 1, metric: 100, measuredPrimary: 100 }),
			result({ runNumber: 2, metric: 80, measuredPrimary: 80 }),
		]);
		expect(labelOf(beaten, 1)).toContain("base");
		expect(labelOf(beaten, 2)).toContain("best");
	});

	it("names at most one baseline and one leader in a segment", () => {
		const runtime = runtimeWith([
			result({ runNumber: 1, metric: 100, measuredPrimary: 100 }),
			result({ runNumber: 2, metric: 90, measuredPrimary: 90 }),
			result({ runNumber: 3, metric: 80, measuredPrimary: 80 }),
			result({ runNumber: 4, metric: 85, measuredPrimary: 85 }),
		]);
		const labels = [1, 2, 3, 4].map(number => labelOf(runtime, number));
		expect(labels.filter(label => label.endsWith("base"))).toHaveLength(1);
		expect(labels.filter(label => label.endsWith("best"))).toHaveLength(1);
		expect(labelOf(runtime, 3)).toContain("best");
	});

	it("compares a run against the baseline of its own segment", () => {
		// An archived run was judged against the segment it ran in. Reading it
		// against a later segment's baseline describes a comparison the loop never
		// made, and the two baselines here are far enough apart that a row using
		// the wrong one cannot round to the right percentage.
		const runtime = runtimeWith([
			result({ runNumber: 1, segment: 0, metric: 100, measuredPrimary: 100 }),
			result({ runNumber: 2, segment: 0, metric: 50, measuredPrimary: 50 }),
			result({ runNumber: 3, segment: 1, metric: 400, measuredPrimary: 400 }),
			result({ runNumber: 4, segment: 1, metric: 200, measuredPrimary: 200 }),
		]);
		runtime.state.currentSegment = 1;
		expect(labelOf(runtime, 2)).toContain("-50.0%");
		expect(labelOf(runtime, 4)).toContain("-50.0%");
		// The baseline of each segment is the reference, so it states no change.
		expect(labelOf(runtime, 1)).not.toContain("%");
		expect(labelOf(runtime, 3)).not.toContain("%");
		// And the roles are per segment too: an archived segment keeps its own
		// reference and its own leader rather than deferring to the live one.
		for (const [baseline, leader] of [
			[1, 2],
			[3, 4],
		]) {
			expect(labelOf(runtime, baseline)).toContain("base");
			expect(labelOf(runtime, leader)).toContain("best");
		}
	});

	it("carries the arm beside the run number", () => {
		// In a breadth of four, `#12` alone does not identify the candidate that produced
		// the reading, and the arm is the whole record of that.
		const runtime = runtimeWith([
			result({ runNumber: 1, metric: 100, measuredPrimary: 100, arm: "a" }),
			result({ runNumber: 2, metric: 80, measuredPrimary: 80, arm: "c" }),
		]);
		expect(labelOf(runtime, 2)).toMatch(/^#2 c {2}/);
		// A serial run has none, and gets no empty column reserved where one would
		// be: the number is followed straight by the two-space column separator.
		const serial = runtimeWith([result({ runNumber: 1, metric: 100, measuredPrimary: 100 })]);
		expect(serial.state.results[0].arm).toBeNull();
		expect(labelOf(serial, 1)).toMatch(/^#1 {2}100ms/);
	});

	it("sheds the change before the verdict, and neither before the number", () => {
		// The verdict outranks the change: a reader can recover a change from two
		// numbers in an aligned column and cannot recover which run the loop kept
		// from anything on the row. Swept over every sidebar width the screen
		// produces rather than over three remembered ones.
		const runtime = runtimeWith([
			result({ runNumber: 1, metric: 100, measuredPrimary: 100 }),
			result({ runNumber: 2, metric: 80, measuredPrimary: 80 }),
		]);
		let sawDeltaShed = false;
		let previousHadDelta = false;
		for (const width of reachableSidebarWidths()) {
			const label = labelOf(runtime, 2, width);
			const hasTag = label.includes("best");
			const hasDelta = label.includes("%");
			// The number and the metric are never shed: a row without them
			// identifies nothing and reports nothing.
			expect(label.startsWith("#2")).toBe(true);
			expect(label).toContain("80ms");
			// The change needs the verdict to already fit, so the two never invert.
			if (hasDelta) expect(hasTag).toBe(true);
			if (!hasDelta && previousHadDelta) throw new Error(`change returned at width ${width} after being shed`);
			if (!hasDelta) sawDeltaShed = true;
			previousHadDelta = hasDelta;
		}
		// The ladder is only a ladder if the narrow end sheds.
		expect(sawDeltaShed).toBe(true);
	});

	it("still states the verdict in a segment with no percentage to print", () => {
		// The baseline and a run that measured nothing: there is no change to show
		// on either row, and that is no reason to stop stating which of the two is
		// which. Conditioning the tag on the change existing suppressed both.
		const runtime = runtimeWith([
			result({ runNumber: 1, metric: 100, measuredPrimary: 100 }),
			result({ runNumber: 2, metric: 0, measuredPrimary: null, status: "crash" }),
		]);
		expect(labelOf(runtime, 1)).toContain("base");
		expect(labelOf(runtime, 2)).toContain("crash");
		expect(labelOf(runtime, 2)).not.toContain("%");
	});

	it("sheds a column rather than overflowing the sidebar it was measured for", () => {
		// The label is padded into columns, and a padded row that outgrows its pane
		// is truncated by the list — which takes the tag off the right-hand end and
		// undoes the ladder above. Long values on every column at once.
		//
		// The number and the metric cannot shed: a row without them identifies
		// nothing and reports nothing, so on a sidebar too narrow for even those
		// two the row is allowed to be the two of them and no more. Every column
		// past that pair is the ladder's to give up, and this asserts it does.
		const runtime = runtimeWith([
			result({ runNumber: 1, metric: 1234.5678, measuredPrimary: 1234.5678, arm: "delta" }),
			result({ runNumber: 9999, metric: 0.0001, measuredPrimary: 0.0001, arm: "epsilon" }),
			result({ runNumber: 10000, metric: 0, measuredPrimary: null, status: "crash", arm: "zeta", flagged: true }),
		]);
		const TAGS = [...Object.values(TAG_FOR), "flag", "base", "best"];
		let sawShedding = false;
		let sawVerdict = false;
		for (const width of reachableSidebarWidths()) {
			for (const number of [1, 9999, 10000]) {
				const label = labelOf(runtime, number, width);
				if (visibleWidth(label) > width - 5) {
					// Over budget only because the unsheddable pair alone is, never
					// because a sheddable column stayed on the row.
					expect(label).not.toContain("%");
					for (const tag of TAGS) expect(label).not.toContain(tag);
					sawShedding = true;
				} else if (TAGS.some(tag => label.endsWith(tag))) {
					sawVerdict = true;
				}
			}
		}
		// A ladder that never sheds and a ladder that never fills are both vacuous.
		// Any verdict, not one named here: run 10000 crashed and is flagged, and
		// `flag` outranks `crash`, so a sweep looking for the word "crash" asserts
		// a row this corpus cannot produce and passes only by never reaching the
		// branch.
		expect(sawShedding).toBe(true);
		expect(sawVerdict).toBe(true);
	});

	it("pads the columns so they line up down the list", () => {
		// A ledger read by scanning has to be a ledger: ragged columns are what the
		// row used to be, and are why nothing in it could be compared by eye.
		const runtime = runtimeWith([
			result({ runNumber: 1, metric: 100, measuredPrimary: 100 }),
			result({ runNumber: 20, metric: 8.5, measuredPrimary: 8.5 }),
			result({ runNumber: 300, metric: 1234.5, measuredPrimary: 1234.5, status: "discard" }),
		]);
		const labels = [1, 20, 300].map(number => labelOf(runtime, number));
		// Through the formatter the row itself uses, so a thousands separator or a
		// precision change moves the expectation with the product.
		const metricColumns = [100, 8.5, 1234.5].map((value, index) => labels[index].indexOf(formatNum(value, "ms")));
		expect(metricColumns.every(column => column > 0)).toBe(true);
		expect(new Set(metricColumns).size).toBe(1);
	});
});
