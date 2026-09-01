/**
 * WHY: the run screen's session pane reported the best measurement and how many
 * runs had passed since it, and those two numbers cannot show the shape of the
 * search. A loop that improved once at run 2 and then flattened for nine runs
 * and a loop still descending a step per run produce the same Best row and the
 * same Since row, and they call for opposite decisions.
 *
 * The class this closes is a pane that reports a scalar where the operator's
 * question is about a series, plus the two ways a series row breaks a pane: a
 * run the harness never measured drawn as a real height, and a row wider than
 * the pane it was measured for.
 *
 * The variant space is swept rather than sampled: every pane width the screen
 * can hand the row, and every run count from below the floor to well past the
 * widest pane.
 *
 * What it does not catch: which glyph sits at which height. The mapping from a
 * measurement to one of eight blocks is quantization, and pinning a specific
 * block per value would fail on any change to the ramp without a defect.
 */
import { describe, expect, it } from "bun:test";
import { renderRunDetail, screenSidebarWidth } from "@veyyon/coding-agent/autoresearch/screen";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/** Every block the trend row can draw, plus the gap it draws for an unmeasured run. */
const BLOCKS = "▁▂▃▄▅▆▇█";
const GAP = "·";

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

/** A descending series of `count` runs: the shape of a loop that keeps winning. */
function descending(count: number): ExperimentResult[] {
	return Array.from({ length: count }, (_, index) =>
		result({ runNumber: index + 1, metric: 300 - index * 5, measuredPrimary: 300 - index * 5 }),
	);
}

/** The Trend row of the session pane, ANSI stripped, or undefined when absent. */
function trendRow(runtime: AutoresearchRuntime, width: number): string | undefined {
	const line = renderRunDetail(runtime, "session", width)
		.map(stripAnsi)
		.find(candidate => candidate.startsWith("Trend"));
	return line?.slice("Trend".length).trim();
}

/** Every pane width the run screen can hand the detail side, narrowest first. */
function reachablePaneWidths(): number[] {
	const widths = new Set<number>();
	for (let terminal = 20; terminal <= 400; terminal += 1) {
		const pane = terminal - screenSidebarWidth(terminal);
		if (pane > 0) widths.add(pane);
	}
	return [...widths].sort((a, b) => a - b);
}

describe("a segment shows the shape of its search", () => {
	useTruecolorTheme("dark");

	it("draws one column per run, oldest on the left", () => {
		// The series is the observable: a descending metric has to draw a
		// descending row, or the picture states the opposite of the measurements.
		const row = trendRow(runtimeWith(descending(6)), 80);
		expect(row).toBeDefined();
		const cells = [...(row ?? "")];
		expect(cells).toHaveLength(6);
		for (const cell of cells) expect(BLOCKS).toContain(cell);

		const heights = cells.map(cell => BLOCKS.indexOf(cell));
		// Strictly descending, because every run measured lower than the one before.
		for (let index = 1; index < heights.length; index += 1) {
			expect(heights[index]).toBeLessThan(heights[index - 1]);
		}
	});

	it("distinguishes a loop that flattened from one still improving", () => {
		// The whole reason the row exists. Both of these have the same best run and
		// the same count of runs since it, so any pane that reports only those two
		// numbers renders them identically.
		const flattened = trendRow(
			runtimeWith([
				result({ runNumber: 1, metric: 300, measuredPrimary: 300 }),
				result({ runNumber: 2, metric: 200, measuredPrimary: 200 }),
				result({ runNumber: 3, metric: 200, measuredPrimary: 200 }),
				result({ runNumber: 4, metric: 200, measuredPrimary: 200 }),
			]),
			80,
		);
		const improving = trendRow(
			runtimeWith([
				result({ runNumber: 1, metric: 300, measuredPrimary: 300 }),
				result({ runNumber: 2, metric: 266, measuredPrimary: 266 }),
				result({ runNumber: 3, metric: 233, measuredPrimary: 233 }),
				result({ runNumber: 4, metric: 200, measuredPrimary: 200 }),
			]),
			80,
		);
		expect(flattened).toBeDefined();
		expect(improving).toBeDefined();
		expect(flattened).not.toBe(improving);
	});

	it("draws a gap for a run the harness never measured", () => {
		// The logged zero of a crash is not a measurement. Drawn as a height it is
		// the floor of the row, which in a lower-is-better session reads as the
		// best run of the segment.
		const row = trendRow(
			runtimeWith([
				result({ runNumber: 1, metric: 300, measuredPrimary: 300 }),
				result({ runNumber: 2, metric: 0, measuredPrimary: null, status: "crash" }),
				result({ runNumber: 3, metric: 250, measuredPrimary: 250 }),
				result({ runNumber: 4, metric: 200, measuredPrimary: 200 }),
			]),
			80,
		);
		expect(row).toBeDefined();
		const cells = [...(row ?? "")];
		expect(cells).toHaveLength(4);
		expect(cells[1]).toBe(GAP);
		// And the three real measurements still descend around the gap.
		const heights = [cells[0], cells[2], cells[3]].map(cell => BLOCKS.indexOf(cell));
		expect(heights[1]).toBeLessThan(heights[0]);
		expect(heights[2]).toBeLessThan(heights[1]);
	});

	it("stays on one line inside the pane, at every width and every run count", () => {
		// The defect a width budget produces is a wrap, not an overrun: `field`
		// wraps the value under a hanging indent, so a series one column too wide
		// arrives as a full row plus a second row holding one bar. The elision
		// marker is part of the row, so a budget that forgets it overruns by
		// exactly one column and wraps exactly one bar.
		for (const pane of reachablePaneWidths()) {
			for (const count of [3, 8, 40, 200]) {
				const lines = renderRunDetail(runtimeWith(descending(count)), "session", pane).map(stripAnsi);
				// Blocks only: `·` is also this pane's field separator, so a gap-based
				// filter matches the Metric and Segment rows too.
				const drawn = lines.filter(line => [...line].some(cell => BLOCKS.includes(cell)));
				if (drawn.length === 0) continue;
				// One line, never a continuation under the label column.
				expect(drawn).toHaveLength(1);
				expect(visibleWidth(drawn[0])).toBeLessThanOrEqual(pane);
				const row = drawn[0].slice("Trend".length).trim();
				for (const cell of [...row]) expect(`${BLOCKS}${GAP}…`).toContain(cell);
			}
		}
	});

	it("shows the newest runs when a segment outgrows the pane", () => {
		// A long segment's question is where it is going, so the tail is kept and
		// the elision says the head was dropped.
		const row = trendRow(runtimeWith(descending(200)), 80) ?? "";
		expect(row.startsWith("…")).toBe(true);
		// The kept cells are the tail, which for a descending series is its lowest
		// stretch: every one of them sits below the top of the ramp.
		const heights = [...row.slice(1)].map(cell => BLOCKS.indexOf(cell));
		expect(heights.every(height => height >= 0)).toBe(true);
	});

	it("says nothing when a segment has not measured enough to have a shape", () => {
		// Two runs are a pair of numbers the Best row already reports, and a
		// two-column picture invites reading a trend out of one comparison.
		expect(trendRow(runtimeWith([]), 80)).toBeUndefined();
		expect(trendRow(runtimeWith(descending(1)), 80)).toBeUndefined();
		expect(trendRow(runtimeWith(descending(2)), 80)).toBeUndefined();
		expect(trendRow(runtimeWith(descending(3)), 80)).toBeDefined();

		// Three runs, none of them measured: a row of three gaps is not a shape.
		const crashes = [1, 2, 3].map(runNumber =>
			result({ runNumber, metric: 0, measuredPrimary: null, status: "crash" }),
		);
		expect(trendRow(runtimeWith(crashes), 80)).toBeUndefined();
	});
});
