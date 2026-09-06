/**
 * WHY: a list on screen whose data changes is rebuilt by its host, and a rebuilt
 * `SelectList` is a NEW list — the query the reader typed is gone and the cursor
 * is back on the first row. The autoresearch run screen previously exposed this
 * via live clocks in list data and search filtering.
 *
 * Two contracts are defended:
 * 1. The run screen (`model: null`): printable characters filter the ledger,
 *    the filter survives background runs being logged, and Esc clears the
 *    active filter before closing the screen.
 * 2. The dashboard (`model: LoopConsoleModel`): the setup view opened with `e`
 *    takes printable keystrokes as the goal, the typed goal and the view
 *    survive background runs, and a letter on the ledger is never a filter.
 *
 * The class this closes is lost reader-owned cursor position, discarded in-flight
 * console input or search filter on background run completion, and trapped or
 * uncancelable search filters.
 * What it does not catch: terminal key encoding differences outside the TUI
 * input handler.
 */
import { describe, expect, it } from "bun:test";
import { type ConsoleHost, LoopConsoleModel, type LoopSetup } from "@veyyon/coding-agent/autoresearch/console";
import { BUILTIN_PRESETS } from "@veyyon/coding-agent/autoresearch/presets";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";
import {
	AutoresearchScreenComponent,
	runScreenRows,
} from "@veyyon/coding-agent/modes/terminal/components/dialogs/autoresearch-screen";
import { getSelectListTheme } from "@veyyon/coding-agent/theme/theme";
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
		model: null,
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
			tail: "",
		};
	}
	return runtime;
}

function stubConsole(runtime: AutoresearchRuntime): {
	console: LoopConsoleModel;
	applied: LoopSetup[];
} {
	const applied: LoopSetup[] = [];
	const host: ConsoleHost = {
		situation: () => ({
			session: runtime.state?.name
				? { name: runtime.state.name, branch: runtime.state.branch, runs: runtime.state.results.length }
				: null,
			harness: true,
			modeOn: runtime.autoresearchMode,
			busy: runtime.runningExperiment !== null,
			interrupted: runtime.interrupted,
			pausedOnBranch: null,
			baseline: false,
		}),
		modelExists: () => true,
		presets: () => [...BUILTIN_PRESETS],
		savePreset: () => "saved",
		deletePreset: () => true,
		apply: setup => applied.push(setup),
		act: () => "stay",
	};
	const console = new LoopConsoleModel(
		{
			goal: runtime.goal ?? "",
			breadth: runtime.pendingSwarm?.breadth ?? runtime.state?.breadth ?? 1,
			attempts: runtime.pendingSwarm?.attempts ?? 1,
			certify: runtime.pendingSwarm?.certify ?? false,
			armModels: runtime.pendingSwarm?.armModels ?? [],
			maxIterations: null,
		},
		host,
	);
	return { console, applied };
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

	it("keeps a filter typed into the run screen (model: null) while the loop logs a run, and clears it with Esc before closing", () => {
		// Twenty runs in a twelve-row terminal: more rows than the sidebar can
		// show, which is when the component offers its search.
		const runtime = runtimeWith(20, 5_000);
		let closes = 0;
		const screen = new AutoresearchScreenComponent({
			runtime,
			model: null,
			close: () => {
				closes += 1;
			},
			requestRender: () => {},
			rows: () => 12,
		});
		expect(screen.render(100).some(line => stripAnsi(line).includes("#20"))).toBeTrue();

		// Footer on the run screen without console is RUN_ROW_HINTS
		const initialFrame = screen.render(100).map(line => stripAnsi(line));
		expect(initialFrame.at(-2)).toContain("↑↓ row   pgup/pgdn page   enter detail   esc close");

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

		// Escape clears the active filter first, rather than closing the screen.
		screen.handleInput("\x1b");
		expect(closes).toBe(0);
		const cleared = screen.render(100).map(line => stripAnsi(line));
		expect(cleared.some(line => line.includes("#20") || line.includes("#21"))).toBeTrue();

		// A second Escape closes the screen once the filter is cleared.
		screen.handleInput("\x1b");
		expect(closes).toBe(1);
	});

	it("edits the goal on the setup view, keeps it across logged runs, and never filters the ledger on a letter", () => {
		const runtime = runtimeWith(20, 5_000);
		const { console, applied } = stubConsole(runtime);
		const screen = new AutoresearchScreenComponent({
			runtime,
			model: console,
			close: () => {},
			requestRender: () => {},
			rows: () => 20,
		});

		// `e` opens the setup form, whose ring starts on the Goal row.
		screen.handleInput("e");
		expect(screen.view).toBe("setup");
		for (const char of "faster") screen.handleInput(char);
		expect(console.goal).toBe("faster");
		expect(applied.at(-1)?.goal).toBe("faster");
		const frame1 = screen.render(100).map(line => stripAnsi(line));
		expect(frame1.some(line => line.includes("faster"))).toBe(true);

		// A run logged while the form is open changes the rows under it, but
		// leaves the view, the ring and the typed goal where they were.
		runtime.runningExperiment = null;
		runtime.state.results.push(result({ runNumber: 21, metric: 79 }));
		const frame2 = screen.render(100).map(line => stripAnsi(line));
		expect(screen.view).toBe("setup");
		expect(console.goal).toBe("faster");
		expect(frame2.some(line => line.includes("faster"))).toBe(true);
		for (const char of " now") screen.handleInput(char);
		expect(console.goal).toBe("faster now");

		// Back on the ledger, a letter that is no action key does nothing: the
		// rows stay, and the goal is not typed into.
		screen.handleInput("\x1b");
		expect(screen.view).toBe("ledger");
		const items = runScreenRows(runtime);
		const runIndex = items.findIndex(item => item.value === "run:20");
		expect(runIndex).toBeGreaterThan(0);
		for (let i = 0; i < runIndex; i++) screen.handleInput("\x1b[B");
		for (const char of "play") screen.handleInput(char);
		const frame3 = screen.render(100).map(line => stripAnsi(line));
		expect(frame3.some(line => line.includes("#20"))).toBe(true);
		expect(frame3.some(line => line.includes("#19"))).toBe(true);
		expect(console.goal).toBe("faster now");
	});
});
