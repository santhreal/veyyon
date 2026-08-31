/**
 * What a loop shows while it is running: one status row, and one screen.
 *
 * The row is the always-on part and it is exactly one line — the state, the
 * metric, and the chord that opens the rest. It goes through `ui.setStatus`,
 * which every extension's status shares, rather than through a widget: a widget
 * above the composer is charged to the conversation on every frame, and this one
 * grew to eighteen rows of table that pushed the transcript off a short
 * terminal. Everything that table held is in {@link ./screen}, which is a screen
 * and can afford it.
 */
import { visibleWidth } from "@veyyon/tui";
import type { ExtensionContext } from "../extensibility/extensions";
import { theme } from "../modes/theme/theme";
import { formatElapsed, formatNum } from "./helpers";
import { AutoresearchScreenComponent } from "./screen";
import { AUTORESEARCH_SCREEN_KEY } from "./shortcuts";
import { currentResults, effectiveBreadth } from "./state";
import type { AutoresearchRuntime, DashboardController, ExperimentState } from "./types";

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
	 * benchmark between two of those is exactly when a reader is watching. So the
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
						rows: () => process.stdout.rows ?? 40,
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
		runtime.state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

/**
 * One segment of the row, and the order it is given up in. The host prints the
 * row through `truncateToWidth`, so a row longer than the terminal loses its
 * TAIL — and the tail is the chord, which is the only statement of how to reach
 * everything the row had to leave out. A narrow terminal was told there was a
 * loop and not told where it was.
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
 * when it has nothing to say, so the row reads the same length whatever the
 * loop is doing — and on a terminal too narrow for all of them, the least
 * informative are dropped in turn rather than the row being cut mid-word.
 */
export function renderStatusRow(runtime: AutoresearchRuntime, width = process.stdout.columns ?? 80): string {
	const state = runtime.state;
	const segments: StatusSegment[] = [
		{ text: theme.fg("accent", effectiveBreadth(runtime) > 1 ? "autoswarm" : "autoresearch"), drop: 0 },
	];

	if (runtime.runningExperiment) {
		segments.push(
			{ text: theme.fg("warning", `run #${runtime.runningExperiment.runNumber}`), drop: 7 },
			{ text: theme.fg("dim", formatElapsed(Date.now() - runtime.runningExperiment.startedAt)), drop: 6 },
		);
	} else if (runtime.lastRunSummary) {
		segments.push(
			{
				text: theme.fg(
					"warning",
					`run #${runtime.lastRunSummary.runNumber} ${runtime.lastRunSummary.passed ? "passed" : "failed"}`,
				),
				drop: 7,
			},
			{ text: theme.fg("dim", "log pending"), drop: 6 },
		);
	} else if (state.results.length === 0) {
		segments.push({
			text: theme.fg("warning", runtime.autoresearchMode ? "baseline pending" : "not started"),
			drop: 7,
		});
	}

	if (state.results.length > 0) {
		const current = currentResults(state.results, state.currentSegment);
		segments.push({ text: theme.fg("muted", `${current.length} runs`), drop: 3 });
		segments.push({
			text: theme.fg("success", `${current.filter(result => result.status === "keep").length} kept`),
			drop: 4,
		});
		if (state.breadth > 1) segments.push({ text: theme.fg("muted", `${state.breadth} arms`), drop: 2 });
		const flagged = current.filter(result => result.flagged).length;
		if (flagged > 0) segments.push({ text: theme.fg("warning", `${flagged} flagged`), drop: 8 });
		const best = bestMetric(state);
		if (best !== null)
			segments.push({ text: theme.fg("toolTitle", `best ${formatNum(best, state.metricUnit)}`), drop: 5 });
		if (state.confidence !== null)
			segments.push({ text: theme.fg("dim", `conf ${state.confidence.toFixed(1)}x`), drop: 1 });
	}

	if (!runtime.autoresearchMode) segments.push({ text: theme.fg("dim", "mode off"), drop: 9 });
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

/** Best kept, unflagged metric of the current segment. */
function bestMetric(state: ExperimentState): number | null {
	let best: number | null = null;
	for (const result of currentResults(state.results, state.currentSegment)) {
		if (result.status !== "keep" || result.flagged || result.metric <= 0) continue;
		if (best === null || (state.bestDirection === "lower" ? result.metric < best : result.metric > best)) {
			best = result.metric;
		}
	}
	return best;
}
