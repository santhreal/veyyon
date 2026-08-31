/**
 * WHY: the loop's always-on surface is one status row, and the host prints it
 * through `truncateToWidth`. The row was one joined string of up to nine
 * segments, so a terminal narrower than the string lost its TAIL — and the tail
 * is `ctrl+x runs`, the only statement of where everything the row left out can
 * be read. A narrow terminal was told a loop existed and not told how to open
 * it, and the cut landed mid-word.
 *
 * The class is a one-line surface whose content grows with the session while its
 * viewport does not: the row gains an arm count, a flag count, a metric and a
 * confidence as a run progresses, and every one of them pushed the chord further
 * past the right edge. It is closed by shedding whole segments in a fixed order,
 * with the identity and the chord never shed, so the narrowest row still names
 * the loop and the key that opens it.
 *
 * The sweep is over the row the code builds, not a list of segments written down
 * here: a segment added to `renderStatusRow` without a shed rank is caught by the
 * monotonicity case, which requires every narrower row to be a subset of the
 * wider one.
 *
 * The session under test has no run in flight, because the elapsed-time segment
 * is a function of the clock and a sweep over 140 widths would compare two
 * different rows. The clock itself is defended by
 * `a-running-loop-repaints-its-own-clock.test.ts`.
 *
 * What it does not catch: colour, which the theme owns, and the host's own
 * truncation, which still applies below the width the identity and the chord
 * need together.
 */
import { describe, expect, it } from "bun:test";
import { createDashboardController, renderStatusRow } from "@veyyon/coding-agent/autoresearch/dashboard";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { useTruecolorTheme } from "./helpers/theme-assertions";

function result(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
	return {
		runNumber: 1,
		commit: "abcdef1234567890",
		metric: 100,
		measuredPrimary: 100,
		metrics: {},
		status: "keep",
		description: "shortened the hot loop",
		timestamp: 0,
		segment: 0,
		confidence: null,
		modifiedPaths: ["src/a.ts"],
		scopeDeviations: [],
		justification: null,
		flagged: false,
		flaggedReason: null,
		arm: null,
		certifiedBy: null,
		...overrides,
	};
}

/**
 * The widest row the loop produces without a live clock in it: a swarm owed a
 * log, with kept runs, arms, a flagged run, a best metric and a confidence.
 * Every optional segment is present, which is the state the shed has to survive.
 */
function loudestRuntime(): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.name = "startup-latency";
	runtime.state.metricName = "duration";
	runtime.state.metricUnit = "ms";
	runtime.state.breadth = 4;
	runtime.state.confidence = 2.5;
	runtime.state.results = [
		result({ runNumber: 1, metric: 120 }),
		result({ runNumber: 2, metric: 90 }),
		result({ runNumber: 3, metric: 80, flagged: true, flaggedReason: "measured on a dirty tree" }),
		result({ runNumber: 4, metric: 70, status: "discard" }),
	];
	runtime.lastRunSummary = {
		command: "bash autoresearch.sh",
		durationSeconds: 12,
		parsedAsi: null,
		parsedMetrics: null,
		parsedPrimary: 70,
		passed: true,
		preRunDirtyPaths: [],
		runDirectory: "/repo/.autoresearch/run-5",
		runNumber: 5,
		exitCode: 0,
		timedOut: false,
	};
	return runtime;
}

/** The row's segments as text, which is what a reader actually gets. */
function segmentsOf(runtime: AutoresearchRuntime, width: number): string[] {
	return stripAnsi(renderStatusRow(runtime, width))
		.split("·")
		.map(part => part.trim())
		.filter(part => part.length > 0);
}

function ctxWriting(rows: Array<string | undefined>): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				rows.push(text);
			},
		},
	} as unknown as ExtensionContext;
}

/** Pretend the terminal is `columns` wide, and hand back the real descriptor. */
function withColumns(columns: number): () => void {
	const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
	return () => {
		if (original) Object.defineProperty(process.stdout, "columns", original);
		else Reflect.deleteProperty(process.stdout, "columns");
	};
}

describe("the status row keeps the chord that opens it", () => {
	// The row paints through the process-wide theme, so a suite that renders it
	// has to install one and put the previous instance back.
	useTruecolorTheme("dark");

	it("names the loop and the chord at every width the two of them fit", () => {
		const runtime = loudestRuntime();
		// The floor is stated, not measured off the row under test: reading it back
		// from `renderStatusRow` is the row grading its own homework, and a build
		// that sheds nothing at all would hand back its full width and be swept
		// only from there.
		const floor = visibleWidth("autoswarm · ctrl+x runs");
		for (let width = floor; width <= 160; width += 1) {
			const row = stripAnsi(renderStatusRow(runtime, width));
			expect(row).toContain("autoswarm");
			expect(row).toContain("ctrl+x runs");
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("sheds whole segments, and never one it kept at a narrower width", () => {
		// Monotonic in both directions: growing the terminal only adds segments,
		// and narrowing it only removes them. A segment present at 60 and gone at
		// 80 would mean the shed depends on something other than width, which is
		// how a row comes to flicker under a drag-resize.
		const runtime = loudestRuntime();
		let previous = segmentsOf(runtime, 20);
		for (let width = 21; width <= 160; width += 1) {
			const current = segmentsOf(runtime, width);
			for (const segment of previous) expect(current).toContain(segment);
			previous = current;
		}
		// The widest row is the whole row: nothing is shed when everything fits.
		expect(previous).toEqual(segmentsOf(runtime, 400));
	});

	it("gives up the least informative segment first", () => {
		// The order is a product decision, so it is pinned rather than described:
		// confidence goes before the arm count, which goes before the run counts,
		// which go before the metric, and the run itself outlives all of them.
		const runtime = loudestRuntime();
		const widest = segmentsOf(runtime, 400);
		const shedBy = (width: number): string[] => {
			const kept = new Set(segmentsOf(runtime, width));
			return widest.filter(segment => !kept.has(segment));
		};
		const full = visibleWidth(stripAnsi(renderStatusRow(runtime, 400)));
		expect(shedBy(full)).toEqual([]);
		// One column short of the whole row costs the confidence and nothing else,
		// and the row is then exactly that segment and its separator narrower.
		expect(shedBy(full - 1)).toEqual(["conf 2.5x"]);
		expect(shedBy(full - 12)).toEqual(["conf 2.5x"]);
		expect(shedBy(full - 13)).toEqual(["4 arms", "conf 2.5x"]);
		// Down to the floor, what is left is the loop and the way in.
		expect(segmentsOf(runtime, 1)).toEqual(["autoswarm", "ctrl+x runs"]);
	});

	it("rebuilds the row when the terminal is resized under it", () => {
		// The host holds the string the row was last set to and re-truncates it, so
		// a row shed for a wide terminal stays wrong after a narrowing until
		// something rebuilds it. Nothing else does: the extension calls `update` on
		// a state transition, and a resize is not one.
		const rows: Array<string | undefined> = [];
		const controller = createDashboardController();
		const runtime = loudestRuntime();
		const restore = withColumns(200);
		try {
			controller.update(ctxWriting(rows), runtime);
			expect(stripAnsi(rows.at(-1) ?? "")).toContain("conf 2.5x");

			withColumns(34);
			process.stdout.emit("resize");
			const narrowed = stripAnsi(rows.at(-1) ?? "");
			expect(narrowed).not.toContain("conf 2.5x");
			expect(narrowed).toContain("ctrl+x runs");
			expect(visibleWidth(narrowed)).toBeLessThanOrEqual(34);
		} finally {
			controller.clear(ctxWriting(rows));
			restore();
		}
	});

	it("stops listening for resizes once the loop is gone", () => {
		// The listener is attached per painted row and removed with it, because a
		// controller that leaves one behind adds a listener to `process.stdout` for
		// every session the process opens.
		const rows: Array<string | undefined> = [];
		const controller = createDashboardController();
		const before = process.stdout.listenerCount("resize");
		controller.update(ctxWriting(rows), loudestRuntime());
		expect(process.stdout.listenerCount("resize")).toBe(before + 1);
		controller.clear(ctxWriting(rows));
		expect(process.stdout.listenerCount("resize")).toBe(before);
	});
});
