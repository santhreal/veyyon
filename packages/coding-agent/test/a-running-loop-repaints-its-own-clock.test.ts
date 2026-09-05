/**
 * WHY: the status row states the elapsed time of the run in flight, and the only
 * thing that repainted it was the extension calling `update` on a state
 * transition. A benchmark between two transitions is exactly the minute a reader
 * is watching the row, so the clock sat frozen at the elapsed time the run had
 * when it started, and a long run looked hung.
 *
 * The class is a surface that states a live value and has no clock of its own.
 * Closed here at the controller, which is the only owner of that clock, in both
 * directions: it advances while a run is in flight, and it stands down when
 * there is nothing in flight and no screen open. The second half is the half
 * that regresses silently — an interval nobody clears keeps an idle session on
 * the event loop for the rest of the process.
 *
 * These cases run on the real clock rather than a fake one, because the contract
 * is that the row repaints without anybody asking, and a fake timer proves only
 * that a callback was registered.
 *
 * What it does not catch: the row's content (the command suite owns that), and
 * the screen's own repaint, which shares this timer but is observed through a
 * TUI handle no test here holds.
 */
import { describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createDashboardController } from "@veyyon/coding-agent/autoresearch/dashboard";
import { createSessionRuntime } from "@veyyon/coding-agent/autoresearch/state";
import type { AutoresearchRuntime } from "@veyyon/coding-agent/autoresearch/types";
import type { ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import { stripAnsi } from "@veyyon/utils";
import { useTruecolorTheme } from "./helpers/theme-assertions";

/** One tick of the controller's clock, plus the slack a loaded runner needs. */
const ONE_TICK_MS = 1_300;

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

/** A loop with a run that started five seconds ago, so the clock has to move. */
function runtimeRunning(): AutoresearchRuntime {
	const runtime = createSessionRuntime();
	runtime.autoresearchMode = true;
	runtime.state.name = "startup-latency";
	runtime.state.metricUnit = "ms";
	runtime.runningExperiment = {
		runNumber: 1,
		startedAt: Date.now() - 5_000,
		command: "bash autoresearch.sh",
		runDirectory: "/repo/.autoresearch/run-1",
		tail: "",
	};
	return runtime;
}

describe("a running loop repaints its own clock", () => {
	// The row paints through the process-wide theme, so a suite that renders it
	// has to install one and put the previous instance back.
	useTruecolorTheme("dark");

	it("advances the elapsed time without another state transition", async () => {
		const rows: Array<string | undefined> = [];
		const dashboard = createDashboardController();
		const runtime = runtimeRunning();

		dashboard.update(ctxWriting(rows), runtime);
		const first = rows.at(-1);
		expect(stripAnsi(first ?? "")).toContain("run #1");
		await sleep(ONE_TICK_MS);

		expect(rows.length).toBeGreaterThanOrEqual(2);
		// Five seconds in when the row was first written, six or more by now: the
		// repaint came from the controller, not from a caller.
		expect(rows.at(-1)).not.toBe(first);
		dashboard.clear(ctxWriting(rows));
	});

	it("stands its clock down when the run ends", async () => {
		const rows: Array<string | undefined> = [];
		const ctx = ctxWriting(rows);
		const dashboard = createDashboardController();
		const runtime = runtimeRunning();
		dashboard.update(ctx, runtime);
		await sleep(ONE_TICK_MS);

		// The run is logged: the loop is still live, and the row is still there,
		// but there is no longer a value on it that changes on its own.
		runtime.runningExperiment = null;
		dashboard.update(ctx, runtime);
		const settled = rows.length;
		await sleep(ONE_TICK_MS);

		expect(rows.length).toBe(settled);
		expect(rows.at(-1)).toBeDefined();
		dashboard.clear(ctx);
	});

	it("takes the row away when the loop is cleared", async () => {
		const rows: Array<string | undefined> = [];
		const ctx = ctxWriting(rows);
		const dashboard = createDashboardController();
		const runtime = runtimeRunning();
		dashboard.update(ctx, runtime);

		dashboard.clear(ctx);
		const cleared = rows.length;
		await sleep(ONE_TICK_MS);

		// A row that outlives its loop advertises a chord onto a session that is
		// over, and a clock still running behind it keeps writing that row.
		expect(rows.at(-1)).toBeUndefined();
		expect(rows.length).toBe(cleared);
	});
});
