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
			stopRefresh();
			if (ctx.hasUI) ctx.ui.setStatus("autoresearch", undefined);
		},
		requestRender,
		update(ctx, runtime): void {
			if (!ctx.hasUI) return;
			if (!hasSession(runtime)) {
				ticking = null;
				syncTimer();
				ctx.ui.setStatus("autoresearch", undefined);
				return;
			}
			ticking = runtime.runningExperiment ? { ctx, runtime } : null;
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
 * The one row. Left to right: what this is, what it is doing now, where the
 * metric stands, and the chord. Every segment is dropped rather than shortened
 * when it has nothing to say, so the row reads the same length whatever the
 * loop is doing.
 */
export function renderStatusRow(runtime: AutoresearchRuntime): string {
	const state = runtime.state;
	const parts: string[] = [theme.fg("accent", effectiveBreadth(runtime) > 1 ? "autoswarm" : "autoresearch")];

	if (runtime.runningExperiment) {
		parts.push(
			theme.fg("warning", `run #${runtime.runningExperiment.runNumber}`),
			theme.fg("dim", formatElapsed(Date.now() - runtime.runningExperiment.startedAt)),
		);
	} else if (runtime.lastRunSummary) {
		parts.push(
			theme.fg(
				"warning",
				`run #${runtime.lastRunSummary.runNumber} ${runtime.lastRunSummary.passed ? "passed" : "failed"}`,
			),
			theme.fg("dim", "log pending"),
		);
	} else if (state.results.length === 0) {
		parts.push(theme.fg("warning", runtime.autoresearchMode ? "baseline pending" : "not started"));
	}

	if (state.results.length > 0) {
		const current = currentResults(state.results, state.currentSegment);
		parts.push(theme.fg("muted", `${current.length} runs`));
		parts.push(theme.fg("success", `${current.filter(result => result.status === "keep").length} kept`));
		if (state.breadth > 1) parts.push(theme.fg("muted", `${state.breadth} arms`));
		const flagged = current.filter(result => result.flagged).length;
		if (flagged > 0) parts.push(theme.fg("warning", `${flagged} flagged`));
		const best = bestMetric(state);
		if (best !== null) parts.push(theme.fg("toolTitle", `best ${formatNum(best, state.metricUnit)}`));
		if (state.confidence !== null) parts.push(theme.fg("dim", `conf ${state.confidence.toFixed(1)}x`));
	}

	if (!runtime.autoresearchMode) parts.push(theme.fg("dim", "mode off"));
	parts.push(theme.fg("dim", `${AUTORESEARCH_SCREEN_KEY} runs`));
	return parts.join(theme.fg("borderMuted", " · "));
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
