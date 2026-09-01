/**
 * WHY: a list on screen whose data changes is rebuilt by its host, and a rebuilt
 * `SelectList` is a NEW list — the query the reader typed is gone and the cursor
 * is back on the first row. The autoresearch run screen made that visible: its
 * sidebar carried the elapsed time of the run in flight, so the rows changed
 * once a second, and a filter typed into the sidebar disappeared on the next
 * tick. Filtering a forty-run session was impossible while a run was running.
 *
 * Two contracts, and both are needed: a surface does not put a live clock in
 * list DATA (the clock belongs to the frame, which is repainted from scratch),
 * and a list whose rows are replaced keeps the reader's filter and the row they
 * had selected.
 *
 * The class is reader-owned view state discarded by a data refresh. It is closed
 * at `SelectList.setItems`, the one path a host has to change rows without
 * constructing a new list, and at the run screen, which is the host that
 * refreshes on a timer rather than on a keystroke.
 *
 * What it does not catch: a host that still constructs a second `SelectList`
 * instead of calling `setItems`. Nothing prevents that, and the run screen's own
 * case below is what would notice it there.
 */
import { describe, expect, it } from "bun:test";
import { AutoresearchScreenComponent, runScreenRows } from "@veyyon/coding-agent/autoresearch/screen";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";
import { getSelectListTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type SelectItem, SelectList } from "@veyyon/tui";
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

/** A session of `count` logged runs, with a run in flight that started `ago` ms back. */
function runtimeWith(count: number, ago: number | null): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.name = "startup-latency";
	runtime.state.metricName = "duration";
	runtime.state.metricUnit = "ms";
	runtime.state.results = Array.from({ length: count }, (_unused, index) =>
		result({ runNumber: index + 1, metric: 100 - index }),
	);
	if (ago !== null) {
		runtime.runningExperiment = {
			startedAt: Date.now() - ago,
			command: "bun run bench",
			runDirectory: "/repo/.veyyon/autoresearch/0099",
			runNumber: count + 1,
		};
	}
	return runtime;
}

const ROWS: SelectItem[] = [
	{ value: "alpha", label: "alpha" },
	{ value: "beta", label: "beta" },
	{ value: "gamma", label: "gamma" },
	{ value: "epsilon", label: "epsilon" },
	{ value: "zeta", label: "zeta" },
	{ value: "omega", label: "omega" },
];

/**
 * A list one row shorter than its content, because that is the condition the
 * component's own search is offered under: a list that fits needs no filter.
 */
function listOf(items: SelectItem[]): SelectList {
	return new SelectList(items, Math.max(1, items.length - 1), getSelectListTheme());
}

/** Type `text` into a list one character at a time, as a terminal delivers it. */
function typeInto(list: SelectList, text: string): void {
	for (const char of text) list.handleInput(char);
}

function visibleRows(list: SelectList): string[] {
	return list.render(40).map(line => stripAnsi(line));
}

describe("a typed filter survives the rows changing under it", () => {
	// Both subjects paint through the process-wide theme.
	useTruecolorTheme("dark");

	it("keeps the query, the match set and the cancel ladder across new rows", () => {
		const list = listOf(ROWS);
		typeInto(list, "bet");
		expect(visibleRows(list).some(line => line.includes("beta"))).toBeTrue();
		expect(visibleRows(list).some(line => line.includes("alpha"))).toBeFalse();

		list.setItems([...ROWS, { value: "iota", label: "iota" }]);
		const rows = visibleRows(list);
		expect(rows.some(line => line.includes("beta"))).toBeTrue();
		expect(rows.some(line => line.includes("alpha"))).toBeFalse();
		expect(rows.some(line => line.includes("iota"))).toBeFalse();
		// The query is still the reader's, so Escape clears it rather than closing
		// the host: a filter that survives without its cancel rung is a trap.
		expect(list.hasActiveFilter()).toBeTrue();
		expect(list.getSelectedItem()?.value).toBe("beta");
	});

	it("filters rows that arrived with the replacement", () => {
		// The filter-text cache is built from the rows present when the first
		// keystroke lands. A replacement that leaves it in place filters the OLD
		// rows, so a row added while a query was live can never match.
		const list = listOf(ROWS);
		typeInto(list, "delt");
		expect(list.getSelectedItem()).toBeNull();

		list.setItems([...ROWS, { value: "delta", label: "delta" }]);
		expect(list.getSelectedItem()?.value).toBe("delta");
		expect(visibleRows(list).some(line => line.includes("delta"))).toBeTrue();
	});

	it("follows the selected row by value, not by position", () => {
		const list = listOf(ROWS);
		list.setSelectedIndex(2);
		expect(list.getSelectedItem()?.value).toBe("gamma");
		// A row inserted above the selection used to leave the cursor on the index,
		// which is now a different run.
		list.setItems([{ value: "new", label: "new" }, ...ROWS]);
		expect(list.getSelectedItem()?.value).toBe("gamma");
	});

	it("announces the move when the selected row is gone", () => {
		// A host tracks the selection to render a detail pane for it. Left silent,
		// it would keep rendering a row the list no longer holds.
		const list = listOf(ROWS);
		list.setSelectedIndex(1);
		const announced: string[] = [];
		list.onSelectionChange = item => announced.push(item.value);
		list.setItems(ROWS.filter(item => item.value !== "beta"));
		expect(announced).toEqual(["alpha"]);
		expect(list.getSelectedItem()?.value).toBe("alpha");
	});

	it("stays silent when the selected row survived", () => {
		// The run screen resets the detail pane's scroll on a selection change, so
		// an announcement nobody asked for throws the reader back to the top of a
		// long run detail every time the loop logs something.
		const list = listOf(ROWS);
		list.setSelectedIndex(1);
		const announced: string[] = [];
		list.onSelectionChange = item => announced.push(item.value);
		list.setItems([...ROWS, { value: "iota", label: "iota" }]);
		expect(announced).toEqual([]);
		expect(list.getSelectedItem()?.value).toBe("beta");
	});

	it("does not change the run screen's rows as time passes", () => {
		// Same session, same runs, one in flight — five seconds in, then a minute
		// in. Anything that differs between these two is a clock in list data, and
		// a clock in list data is a filter the reader loses once a second.
		const early = runScreenRows(runtimeWith(3, 5_000));
		const later = runScreenRows(runtimeWith(3, 65_000));
		expect(later).toEqual(early);
	});

	it("keeps a filter typed into the run screen while the loop logs a run", () => {
		// Twenty runs in a twelve-row terminal: more rows than the sidebar can
		// show, which is when the component offers its search.
		const runtime = runtimeWith(20, 5_000);
		const screen = new AutoresearchScreenComponent({
			runtime,
			close: () => {},
			requestRender: () => {},
			rows: () => 12,
		});
		expect(screen.render(100).some(line => stripAnsi(line).includes("#20"))).toBeTrue();

		// "playb" reaches the Playbook row and nothing else: a run row is filtered
		// on its label, which holds its number and its arm and neither of which
		// holds that subsequence.
		screen.handleInput("p");
		screen.handleInput("l");
		screen.handleInput("a");
		screen.handleInput("y");
		screen.handleInput("b");
		const filtered = screen.render(100).map(line => stripAnsi(line));
		expect(filtered.some(line => line.includes("Playbook"))).toBeTrue();
		// No run row survives the filter, and every one of them is numbered.
		expect(filtered.every(line => !line.includes("#"))).toBeTrue();

		// The loop finishes the run in flight and logs another: the rows changed,
		// which is the refresh that used to take the filter with it.
		runtime.runningExperiment = null;
		runtime.state.results.push(result({ runNumber: 21, metric: 79 }));
		const after = screen.render(100).map(line => stripAnsi(line));
		expect(after.some(line => line.includes("Playbook"))).toBeTrue();
		expect(after.every(line => !line.includes("#"))).toBeTrue();
	});
});
