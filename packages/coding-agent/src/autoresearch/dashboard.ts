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
import { theme } from "../modes/theme/theme";
import { formatElapsed, formatNum } from "./helpers";
import { AutoresearchScreenComponent } from "./screen";
import { AUTORESEARCH_SCREEN_KEY } from "./shortcuts";
import { currentResults } from "./state";
import type { AutoresearchRuntime, DashboardController, ExperimentState } from "./types";

export function createDashboardController(): DashboardController {
	let screenTui: { requestRender(): void } | null = null;
	let refreshTimer: NodeJS.Timeout | undefined;

	const requestRender = (): void => {
		screenTui?.requestRender();
	};

	const stopRefresh = (): void => {
		screenTui = null;
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	};

	return {
		clear(ctx): void {
			stopRefresh();
			if (ctx.hasUI) ctx.ui.setStatus("autoresearch", undefined);
		},
		requestRender,
		update(ctx, runtime): void {
			if (!ctx.hasUI) return;
			if (!hasSession(runtime)) {
				ctx.ui.setStatus("autoresearch", undefined);
				return;
			}
			ctx.ui.setStatus("autoresearch", renderStatusRow(runtime));
			requestRender();
		},
		async showScreen(ctx, runtime): Promise<void> {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>(
				(tui, _theme, _keybindings, done) => {
					screenTui = tui;
					// A run in flight has a clock in it, so the screen ticks while one
					// is open. An idle screen has nothing to animate and no timer.
					if (!refreshTimer && runtime.runningExperiment) {
						refreshTimer = setInterval(requestRender, 1000);
					}
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
	const parts: string[] = [theme.fg("accent", state.breadth > 1 ? "autoswarm" : "autoresearch")];

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
