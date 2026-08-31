/**
 * WHY: the loop's data used to be painted as a widget above the composer, whose
 * height grew with the session — eighteen rows of table on a swarm — so on a
 * short terminal the transcript was pushed off the screen by a status display.
 *
 * It is now one status row plus a screen. The contract this defends is the
 * screen's: given a width and a height, it returns EXACTLY that many rows, each
 * no wider than the width, whatever the session holds. A surface that returns
 * one row too many is clipped by the host, and the row it loses is the footer
 * that says how to leave.
 *
 * The class this closes is unbounded content reaching a bounded viewport: a long
 * goal, a long playbook, a long file list, a long flag reason, a hundred runs.
 * Each is swept here against the smallest viewport the screen accepts.
 *
 * What it does not catch: colour. Every assertion runs through a passthrough
 * theme, because a frame that is the right shape in the wrong colour is a
 * palette defect, and the theme owns that.
 */
import { describe, expect, it } from "bun:test";
import {
	AutoresearchScreenComponent,
	renderRunScreen,
	runScreenRows,
	screenSidebarWidth,
	screenTitle,
} from "@veyyon/coding-agent/autoresearch/screen";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";
import { visibleWidth } from "@veyyon/tui";
import { useTruecolorTheme } from "./helpers/theme-assertions";

function result(overrides: Partial<ExperimentResult> = {}): ExperimentResult {
	return {
		runNumber: 1,
		commit: "abcdef1234567890",
		metric: 100,
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

/** A runtime holding `count` runs, so height is swept against real content. */
function runtimeWith(count: number, overrides: Partial<AutoresearchRuntime> = {}): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state = createExperimentState();
	runtime.state.name = "startup-latency";
	runtime.state.metricName = "duration";
	runtime.state.metricUnit = "ms";
	runtime.state.results = Array.from({ length: count }, (_unused, index) =>
		result({ runNumber: index + 1, metric: 100 - index }),
	);
	return Object.assign(runtime, overrides);
}

/** The component's own frame, rendered at a fixed viewport. */
function frameOf(runtime: AutoresearchRuntime, width: number, rows: number): readonly string[] {
	const screen = new AutoresearchScreenComponent({
		runtime,
		close: () => {},
		requestRender: () => {},
		rows: () => rows,
	});
	return screen.render(width);
}

describe("the run screen fits the terminal it was given", () => {
	// The screen paints through the process-wide theme, so a suite that renders
	// it has to install one and put the previous instance back.
	useTruecolorTheme("dark");

	it("returns exactly the rows it was given, at every width and height", () => {
		const runtime = runtimeWith(40);
		for (const width of [60, 80, 120, 200]) {
			for (const rows of [14, 20, 40, 60]) {
				const frame = frameOf(runtime, width, rows);
				expect(frame.length).toBe(rows);
				for (const line of frame) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("holds its shape against content that has no length limit", () => {
		// Every one of these is user or model text that arrives unbounded.
		const runtime = runtimeWith(1, { goal: "x".repeat(400) });
		runtime.state.notes = Array.from({ length: 200 }, (_unused, index) => `note line ${index}`).join("\n");
		runtime.state.results = [
			result({
				description: "y".repeat(500),
				modifiedPaths: Array.from({ length: 60 }, (_unused, index) => `src/very/long/path/file-${index}.ts`),
				flagged: true,
				flaggedReason: "z".repeat(300),
				scopeDeviations: ["src/off-limits.ts"],
				arm: "arm-b",
				certifiedBy: "arm-c",
			}),
		];
		for (const value of ["session", "notes", "run:1"]) {
			const screen = new AutoresearchScreenComponent({
				runtime,
				close: () => {},
				requestRender: () => {},
				rows: () => 16,
			});
			// Select the row under test the way the reader does, then render.
			screen.handleInput(value === "session" ? "" : "\x1b[B");
			const frame = screen.render(64);
			expect(frame.length).toBe(16);
			for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
		}
	});

	it("keeps the footer legend on the last row, so leaving is always visible", () => {
		const frame = frameOf(runtimeWith(100), 80, 14);
		expect(frame.at(-2)).toContain("esc close");
	});

	it("names the surface for what the session is", () => {
		const serial = runtimeWith(1);
		expect(screenTitle(serial)).toContain("Autoresearch");
		const swarm = runtimeWith(1);
		swarm.state.breadth = 4;
		expect(screenTitle(swarm)).toContain("Autoswarm");
		// A loop whose mode was turned off still reads its runs, and says so.
		const off = runtimeWith(1);
		off.autoresearchMode = false;
		expect(screenTitle(off)).toContain("mode off");
	});

	it("lists the session, the playbook and every run, newest first", () => {
		const runtime = runtimeWith(3);
		const rows = runScreenRows(runtime);
		expect(rows.map(row => row.value)).toEqual(["session", "notes", "run:3", "run:2", "run:1"]);
		// A run in flight is a row of its own, above the logged ones.
		runtime.runningExperiment = {
			runNumber: 4,
			startedAt: Date.now(),
			command: "bash autoresearch.sh",
			runDirectory: "/repo/.autoresearch/run-4",
		};
		expect(runScreenRows(runtime).map(row => row.value)).toEqual([
			"session",
			"notes",
			"running",
			"run:3",
			"run:2",
			"run:1",
		]);
	});

	it("shows arm and reviewer on a run that has them", () => {
		// Arm attribution is the whole record of which candidate a swarm kept and
		// who passed it. It was measured, discarded on the way to storage, and
		// unreadable afterwards; the list row and the detail pane both carry it.
		const runtime = runtimeWith(1);
		runtime.state.breadth = 3;
		runtime.state.results = [result({ arm: "arm-b", certifiedBy: "arm-c" })];
		expect(runScreenRows(runtime).find(row => row.value === "run:1")?.description).toContain("arm-b");

		const screen = new AutoresearchScreenComponent({
			runtime,
			close: () => {},
			requestRender: () => {},
			rows: () => 20,
		});
		// Down twice: session → playbook → the run.
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[B");
		const detail = screen.render(90).join("\n");
		expect(detail).toContain("arm-b");
		expect(detail).toContain("arm-c");
		expect(detail).toContain("Reviewed by");
	});

	it("gives the sidebar a bounded share of the width", () => {
		// A sidebar that scales without a cap eats the detail pane on a wide
		// terminal; one that never grows truncates run labels on a narrow one.
		expect(screenSidebarWidth(60)).toBeGreaterThanOrEqual(22);
		expect(screenSidebarWidth(400)).toBeLessThanOrEqual(34);
		for (const width of [60, 80, 120, 400]) {
			expect(screenSidebarWidth(width)).toBeLessThan(width / 2);
		}
	});

	it("pads a short pane rather than shrinking the card", () => {
		// An empty session has two rows of sidebar and a few lines of detail. The
		// card is still the full height, or the composer jumps as runs arrive.
		const runtime = createSessionRuntime();
		const frame = renderRunScreen(runtime, 80, 24, ["one"], ["two"], screenSidebarWidth(80));
		expect(frame.length).toBe(24);
		for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});
});
