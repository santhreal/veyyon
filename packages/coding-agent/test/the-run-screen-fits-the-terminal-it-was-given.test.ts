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
import { homedir } from "node:os";
import {
	AutoresearchScreenComponent,
	renderRunDetail,
	renderRunScreen,
	runScreenRows,
	screenSidebarWidth,
	screenTitle,
} from "@veyyon/coding-agent/autoresearch/screen";
import { createExperimentState, createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime, ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";
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
			// From the shortest frame the card has (four chrome rows around a
			// three-row body) upward: the clamp used to floor at 14 and write eight
			// rows past the bottom of a ten-row terminal.
			for (const rows of [7, 8, 10, 13, 14, 20, 40, 60]) {
				const frame = frameOf(runtime, width, rows);
				expect(frame.length).toBe(rows);
				for (const line of frame) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("never writes more rows than a terminal shorter than its own minimum", () => {
		// Below the seven-row floor there is nothing to shrink: the card states its
		// minimum instead of scaling to two rows, and a host that cannot spare
		// seven rows gets seven rather than a frame torn in half.
		const runtime = runtimeWith(40);
		for (const rows of [1, 3, 6]) {
			expect(frameOf(runtime, 80, rows).length).toBe(7);
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

	it("reads a swarm the console configured before any session exists", () => {
		// Between the setup console and the first `init_experiment` there is no
		// stored session, so `state.breadth` is 1 for a whole turn. The surface
		// titled itself "Autoresearch" and its session pane said "serial, no arms"
		// about a swarm of four that the user had already configured.
		const runtime = runtimeWith(0);
		runtime.pendingSwarm = { breadth: 4, attempts: 2, certify: true };
		expect(screenTitle(runtime)).toContain("Autoswarm");

		const detail = renderRunDetail(runtime, "session", 90).join("\n");
		expect(detail).toContain("4 arms per iteration");
		expect(detail).not.toContain("serial, no arms");
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

	it("names the artifacts directory without the home directory in it", () => {
		// The run directory sits under the profile, so the raw string carries the account name and the
		// profile layout onto every screenshot, demo frame and pasted transcript of a loop. Both the run
		// in flight and the one owed a log print the same path, so both are swept.
		const home = homedir();
		const runtime = runtimeWith(1);
		runtime.runningExperiment = {
			runNumber: 2,
			startedAt: Date.now(),
			command: "bash autoresearch.sh",
			runDirectory: `${home}/.veyyon/profiles/work/autoresearch/0002`,
		};
		const running = renderRunDetail(runtime, "running", 90).join("\n");
		expect(stripAnsi(running)).toContain("~/.veyyon/profiles/work/autoresearch/0002");
		expect(running).not.toContain(home);

		runtime.runningExperiment = null;
		runtime.lastRunSummary = {
			runNumber: 3,
			passed: true,
			command: "bash autoresearch.sh",
			runDirectory: `${home}/.veyyon/profiles/work/autoresearch/0003`,
			parsedPrimary: 98,
			parsedAsi: null,
			parsedMetrics: null,
			preRunDirtyPaths: [],
			durationSeconds: 1.5,
			exitCode: 0,
			timedOut: false,
		};
		const pending = renderRunDetail(runtime, "pending", 90).join("\n");
		expect(stripAnsi(pending)).toContain("~/.veyyon/profiles/work/autoresearch/0003");
		expect(pending).not.toContain(home);
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

	it("fits a terminal narrower than the sidebar wants", () => {
		// The sidebar asks for 22 columns and the pane for what is left, so a
		// terminal narrower than the pair writes a frame wider than the window and
		// the border wraps into a second row nothing accounts for. Every row of
		// every frame stays inside the width it was handed, down to the narrowest
		// terminal a reader can produce.
		for (const width of [10, 20, 29, 40]) {
			const screen = new AutoresearchScreenComponent({
				runtime: runtimeWith(3),
				close: () => {},
				requestRender: () => {},
				rows: () => 12,
			});
			for (const line of screen.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("pages the detail pane, and pages back to where it started", () => {
		// The pane holds a playbook longer than the card, so the rows past the
		// bottom are reachable only through the page keys the footer advertises.
		//
		// Compared as text, not as bytes: the selected row's prefix carries a lava
		// shimmer, which is a function of the clock, so two frames of the same
		// state differ by a colour channel when they land in different animation
		// frames. What paging owes the reader is the same CONTENT it started on.
		const runtime = runtimeWith(1);
		runtime.state.notes = Array.from({ length: 120 }, (_unused, index) => `note line ${index}`).join("\n");
		const screen = new AutoresearchScreenComponent({
			runtime,
			close: () => {},
			requestRender: () => {},
			rows: () => 20,
		});
		const textOf = (): string =>
			screen
				.render(80)
				.map(line => stripAnsi(line))
				.join("\n");
		screen.handleInput("\x1b[B"); // session → playbook
		const first = textOf();
		expect(first).toContain("note line 0");

		screen.handleInput("\x1b[6~");
		const paged = textOf();
		expect(paged).not.toBe(first);
		expect(paged).not.toContain("note line 0");

		screen.handleInput("\x1b[5~");
		expect(textOf()).toBe(first);
	});

	it("closes on escape, and on escape only once the filter is gone", () => {
		// `q` closed the screen and never reached the list, so a reader filtering
		// for a run whose label held a q lost the surface mid-keystroke. Escape is
		// the only chord the card claims, and it clears a live filter before it
		// means leave — the setup wizard lost onboarding to exactly that reading.
		const closes: string[] = [];
		const newScreen = (runs: number, rows: number): AutoresearchScreenComponent =>
			new AutoresearchScreenComponent({
				runtime: runtimeWith(runs),
				close: () => closes.push("closed"),
				requestRender: () => {},
				rows: () => rows,
			});

		const unfiltered = newScreen(3, 20);
		for (const key of ["q", "Q", "\x1b[5~", "\x1b[6~", "\x1b[B"]) unfiltered.handleInput(key);
		expect(closes).toEqual([]);
		unfiltered.handleInput("\x1b");
		expect(closes).toEqual(["closed"]);

		// A list longer than its budget is the one that can be typed into, which is
		// the case where Escape has two meanings.
		closes.length = 0;
		const filtered = newScreen(30, 12);
		filtered.render(80);
		filtered.handleInput("2");
		filtered.handleInput("\x1b");
		expect(closes).toEqual([]);
		// The filter is gone, so this one leaves.
		filtered.handleInput("\x1b");
		expect(closes).toEqual(["closed"]);
	});

	it("expands the control bytes in text it did not write", () => {
		// A literal tab lands on the terminal's tab stops and opens a hole through
		// the pane's columns; an embedded newline pushes a row past the border the
		// caller measured. Both arrive from a model writing a session field.
		const runtime = runtimeWith(1, { goal: "goal\twith\ttabs" });
		// The session name is inset into the top border, which is measured before
		// the name reaches it.
		runtime.state.name = "startup\tlatency";
		runtime.state.notes = "first\tline";
		runtime.state.results = [
			result({ description: "shortened\tthe\nhot loop", flagged: true, flaggedReason: "reason\nover\nlines" }),
		];
		for (const rowIndex of [0, 1, 2]) {
			const screen = new AutoresearchScreenComponent({
				runtime,
				close: () => {},
				requestRender: () => {},
				rows: () => 20,
			});
			for (let step = 0; step < rowIndex; step += 1) screen.handleInput("\x1b[B");
			const frame = screen.render(70);
			expect(frame.length).toBe(20);
			for (const line of frame) {
				expect(line).not.toContain("\t");
				expect(line).not.toContain("\n");
				expect(visibleWidth(line)).toBeLessThanOrEqual(70);
			}
		}
	});

	it("compares an archived run to the baseline of its own segment", () => {
		// A run in segment 1 is judged against segment 1's baseline. Reading every
		// run against the CURRENT segment's baseline stated a comparison the loop
		// never made: here it would read 100ms as +100.0% against a later 50ms.
		const runtime = runtimeWith(0);
		runtime.state.results = [
			result({ runNumber: 1, metric: 200, segment: 0 }),
			result({ runNumber: 2, metric: 100, segment: 0 }),
			result({ runNumber: 3, metric: 50, segment: 1 }),
			result({ runNumber: 4, metric: 25, segment: 1 }),
		];
		runtime.state.currentSegment = 1;
		const screen = new AutoresearchScreenComponent({
			runtime,
			close: () => {},
			requestRender: () => {},
			rows: () => 24,
		});
		const rows = runScreenRows(runtime);
		const index = rows.findIndex(row => row.value === "run:2");
		expect(index).toBeGreaterThan(0);
		for (let step = 0; step < index; step += 1) screen.handleInput("\x1b[B");

		const detail = screen.render(100).join("\n");
		expect(detail).toContain("-50.0%");
		expect(detail).not.toContain("+100.0%");
	});
});
