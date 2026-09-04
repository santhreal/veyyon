/**
 * What a loop shows while it is running: one status row, and one screen.
 *
 * The row is the always-on part and it is one line — the state, the
 * metric, and the chord that opens the rest. It goes through `ui.setStatus`,
 * which every extension's status shares, rather than through a widget: a widget
 * above the composer is charged to the conversation on every frame, and this one
 * grew to eighteen rows of table that pushed the transcript off a short
 * terminal. Everything that table held is in {@link ./screen}, which is a screen
 * and can afford it.
 */
import { sanitizeSingleLine, visibleWidth } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import type { ExtensionContext } from "../extensibility/extensions";
import { theme } from "../modes/theme/theme";
import { truncateToWidth } from "../tools/render-utils";
import { formatElapsed, formatNum, formatPercentChange } from "./helpers";
import { AutoresearchScreenComponent } from "./screen";
import { AUTORESEARCH_SCREEN_KEY } from "./shortcuts";
import { currentResults, effectiveBreadth, findBaselineMetric, findBestKeptResult } from "./state";
import type { AutoresearchRuntime, DashboardController } from "./types";

export function createDashboardController(): DashboardController {
	let screenTui: { requestRender(): void } | null = null;
	let refreshTimer: NodeJS.Timeout | undefined;
	/** The last UI context, so a tick can repaint the row without an event. */
	let ticking: { ctx: ExtensionContext; runtime: AutoresearchRuntime } | null = null;
	/** The last row painted, so a resize can rebuild it against the new width. */
	let painted: { ctx: ExtensionContext; runtime: AutoresearchRuntime } | null = null;

	/**
	 * A row shed for 120 columns is the wrong row at 40, and nothing else
	 * rebuilds it: the host re-prints the string it already holds and truncates
	 * that. So the resize is where the row is built again, and the listener is
	 * attached only while there is a row to rebuild.
	 */
	const onResize = (): void => {
		if (painted?.ctx.hasUI) painted.ctx.ui.setStatus("autoresearch", renderStatusRow(painted.runtime));
	};
	let watchingResize = false;
	const watchResize = (wanted: boolean): void => {
		if (wanted === watchingResize) return;
		watchingResize = wanted;
		if (wanted) process.stdout.on("resize", onResize);
		else process.stdout.off("resize", onResize);
	};

	const requestRender = (): void => {
		screenTui?.requestRender();
	};

	/**
	 * One second is the row's clock and the screen's clock both.
	 *
	 * The row states the elapsed time of the run in flight, and nothing else
	 * repaints it: the extension calls `update` on state transitions, and a
	 * benchmark between two of those is when a reader is watching. So the
	 * timer runs while a run is in flight or the screen is open, and stops as soon
	 * as neither is true, which is what keeps an idle session off the event loop.
	 */
	const syncTimer = (): void => {
		const wanted = ticking !== null || screenTui !== null;
		if (wanted === (refreshTimer !== undefined)) return;
		if (!wanted) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
			return;
		}
		refreshTimer = setInterval(() => {
			if (ticking) ticking.ctx.ui.setStatus("autoresearch", renderStatusRow(ticking.runtime));
			requestRender();
		}, 1000);
	};

	const stopRefresh = (): void => {
		screenTui = null;
		syncTimer();
	};

	return {
		clear(ctx): void {
			ticking = null;
			painted = null;
			watchResize(false);
			stopRefresh();
			if (ctx.hasUI) ctx.ui.setStatus("autoresearch", undefined);
		},
		requestRender,
		update(ctx, runtime): void {
			if (!ctx.hasUI) return;
			if (!hasSession(runtime)) {
				ticking = null;
				painted = null;
				watchResize(false);
				syncTimer();
				ctx.ui.setStatus("autoresearch", undefined);
				return;
			}
			ticking = runtime.runningExperiment ? { ctx, runtime } : null;
			painted = { ctx, runtime };
			watchResize(true);
			syncTimer();
			ctx.ui.setStatus("autoresearch", renderStatusRow(runtime));
			requestRender();
		},
		async showScreen(ctx, runtime): Promise<void> {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>(
				(tui, _theme, _keybindings, done) => {
					screenTui = tui;
					// The screen's own clock: a run in flight ticks it, and so does the
					// row underneath, which is why both share one timer.
					syncTimer();
					const component = new AutoresearchScreenComponent({
						runtime,
						close: () => done(undefined),
						requestRender,
						// The rows the overlay can paint: the window minus the pinned
						// composer zone the overlay stays above.
						rows: () => tui.terminal.rows - tui.pinnedFooterRows,
					});
					return {
						render: (width: number) => component.render(width),
						handleInput: (data: string) => component.handleInput(data),
						dispose: stopRefresh,
					};
				},
				{ overlay: true },
			);
		},
	};
}

/** A loop worth reporting: armed, running, measured, or owed a log. */
function hasSession(runtime: AutoresearchRuntime): boolean {
	return (
		runtime.autoresearchMode ||
		// A paused loop is still a loop worth reporting: dropping the row here is
		// what made a branch switch look like the session had been discarded.
		runtime.pausedOnBranch !== null ||
		runtime.state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

/**
 * One segment of the row, and the order it is given up in. The host prints the
 * row through `truncateToWidth`, so a row longer than the terminal loses its
 * TAIL — and the tail is the chord, which is the only statement of how to reach
 * everything the row had to leave out. A narrow terminal printed that a loop
 * was running and never printed where to look at it.
 *
 * `drop` is the order segments are given up in, lowest first; a segment with
 * drop 0 is never given up. What survives to the narrowest row is what the loop
 * is and how to open it.
 */
interface StatusSegment {
	text: string;
	drop: number;
}

/** Width of the joined row, `separator` included. */
function rowWidth(segments: readonly StatusSegment[]): number {
	return visibleWidth(segments.map(segment => segment.text).join(SEPARATOR));
}

const SEPARATOR = " · ";

/**
 * The one row. Left to right: what this is, what it is doing now, where the
 * metric stands, and the chord. Every segment is dropped rather than shortened
 * when it has nothing to report, so the row reads the same length whatever the
 * loop is doing — and on a terminal too narrow for all of them, the least
 * informative are dropped in turn rather than the row being cut mid-word.
 */
export function renderStatusRow(runtime: AutoresearchRuntime, width = process.stdout.columns ?? 80): string {
	const state = runtime.state;
	// One reading of the breadth for the whole row. The name and the arm count
	// used to come from `effectiveBreadth` and `state.breadth`, which disagree for
	// the whole first turn of a swarm: the row printed `autoswarm` with no arm
	// count, which is the one fact that word implies.
	const breadth = effectiveBreadth(runtime);
	const segments: StatusSegment[] = [
		{ text: theme.fg("accent", breadth > 1 ? "autoswarm" : "autoresearch"), drop: 0 },
	];

	if (runtime.pausedOnBranch) {
		// Why the loop is not running, and the branch that resumes it. Without this
		// the row falls through to the run-status segments below and reads as though
		// nothing was ever measured here.
		segments.push({
			// The branch is the actionable part: it is what the user checks out to
			// resume. Width is the segment system's job, so it is not capped a
			// second time here into something that cannot be typed back.
			text: theme.fg("warning", `paused · session on ${sanitizeSingleLine(runtime.pausedOnBranch)}`),
			// Outranks every other droppable segment: a metric with no explanation of
			// why the loop stopped is the reading that misleads, and this replaces
			// `mode off` rather than sitting beside it.
			drop: 11,
		});
	} else if (runtime.interrupted) {
		// The notice that reported the interrupt scrolls away; the row is what is
		// still on screen when the user comes back to a loop that is not moving.
		segments.push({ text: theme.fg("warning", "paused · send a message to resume"), drop: 11 });
	} else if (runtime.runningExperiment) {
		segments.push(
			{ text: theme.fg("warning", `run #${runtime.runningExperiment.runNumber}`), drop: 8 },
			{ text: theme.fg("dim", formatElapsed(Date.now() - runtime.runningExperiment.startedAt)), drop: 7 },
		);
	} else if (runtime.lastRunSummary) {
		segments.push(
			{
				text: theme.fg(
					"warning",
					`run #${runtime.lastRunSummary.runNumber} ${runtime.lastRunSummary.passed ? "passed" : "failed"}`,
				),
				drop: 8,
			},
			{ text: theme.fg("dim", "log pending"), drop: 7 },
		);
	} else if (state.results.length === 0) {
		segments.push({
			text: theme.fg("warning", runtime.autoresearchMode ? "baseline pending" : "not started"),
			drop: 8,
		});
	}

	// Which arm the edits landing right now belong to, and what is writing them.
	// Without it a per-arm model switch is invisible: the model row changes under
	// the user mid-loop and nothing on screen connects it to an arm.
	if (runtime.activeArm) {
		segments.push({
			text: theme.fg(
				"accent",
				`${runtime.activeArm.arm} on ${truncateToWidth(sanitizeSingleLine(runtime.activeArm.modelLabel), 24)}`,
			),
			drop: 6,
		});
	}

	if (state.results.length > 0) {
		const current = currentResults(state.results, state.currentSegment);
		segments.push({ text: theme.fg("muted", formatCount("run", current.length)), drop: 3 });
		segments.push({
			text: theme.fg("success", `${current.filter(result => result.status === "keep").length} kept`),
			drop: 4,
		});
		if (breadth > 1) segments.push({ text: theme.fg("muted", formatCount("arm", breadth)), drop: 2 });
		const flagged = current.filter(result => result.flagged).length;
		if (flagged > 0) segments.push({ text: theme.fg("warning", `${flagged} flagged`), drop: 5 });
		// The number and what it is worth travel as one segment. `best 192.78ms`
		// alone is a reading nobody can place: the loop exists to move that number
		// off the one it started from, and the row that reports the loop has to
		// report the move, or shed both and report neither.
		//
		// It is also the last thing on the row to be given up, because it is the
		// answer to the question the row exists for. A flag count and a run in
		// flight are the day's exceptions; this is the result.
		// `bestMeasuredRun` is the one rule every surface showing a best uses, so
		// the number here, the tag in the ledger and the count below cannot name
		// different runs.
		const best = findBestKeptResult(state.results, state.currentSegment, state.bestDirection);
		if (best !== null) {
			const change = formatPercentChange(best.metric, findBaselineMetric(state.results, state.currentSegment));
			segments.push({
				text:
					theme.fg("toolTitle", `best ${formatNum(best.metric, state.metricUnit)}`) +
					(change ? theme.fg("dim", ` ${change}`) : ""),
				drop: 9,
			});
			// How long since that best. `best 168.40ms -12.6%` is cumulative and
			// reads as progress at a glance whether it was won last run or forty
			// runs ago, which is what decides whether to leave the loop running. It
			// sheds before the best it qualifies, so a narrow row keeps the result.
			//
			// A run number is optional, and an unnumbered run cannot be ordered
			// against the best: it is not counted, and a best without a number
			// makes the question unanswerable, so the segment is left off.
			const bestNumber = best.runNumber;
			if (bestNumber !== null) {
				const since = current.filter(result => result.runNumber !== null && result.runNumber > bestNumber).length;
				if (since > 0) segments.push({ text: theme.fg("dim", `${since} since best`), drop: 6 });
			}
		}
		if (state.confidence !== null)
			segments.push({ text: theme.fg("dim", `conf ${state.confidence.toFixed(1)}x`), drop: 1 });
	}

	// Above the result: a metric from a loop that is no longer running is the one
	// reading that needs the qualification more than it needs the number.
	// A paused row already states the mode is off and why, so the bare
	// qualification would only crowd out the branch name.
	if (!runtime.autoresearchMode && runtime.pausedOnBranch === null) {
		segments.push({ text: theme.fg("dim", "mode off"), drop: 10 });
	}
	segments.push({ text: theme.fg("dim", `${AUTORESEARCH_SCREEN_KEY} runs`), drop: 0 });

	let kept = segments;
	while (rowWidth(kept) > width) {
		let victim = -1;
		for (let index = 0; index < kept.length; index += 1) {
			const drop = kept[index].drop;
			if (drop === 0) continue;
			if (victim === -1 || drop < kept[victim].drop) victim = index;
		}
		if (victim === -1) break;
		kept = kept.filter((_segment, index) => index !== victim);
	}
	return kept.map(segment => segment.text).join(theme.fg("borderMuted", SEPARATOR));
}
