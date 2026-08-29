import { ScrollView, Text } from "@veyyon/tui";
import { matchesKey } from "@veyyon/utils/keys";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import {
	bottomBorder,
	divider,
	keyLegend,
	row,
	type StatCell,
	statStrip,
	topBorder,
} from "../modes/terminal/components/chrome/overlay-box";
import type { ThemeColor } from "../theme/color";
import type { Theme } from "../theme/theme";
import { formatElapsed, formatNum, formatPercentChange, isBetter } from "./helpers";
import { AUTORESEARCH_OVERLAY_KEY, AUTORESEARCH_TOGGLE_KEY } from "./shortcuts";
import { currentResults, findBaselineMetric, findBaselineRunNumber, findBaselineSecondary } from "./state";
import type { AutoresearchRuntime, DashboardController, ExperimentResult, ExperimentState } from "./types";

/**
 * Rows the overlay frame costs regardless of content: the titled top border, the
 * rule under the stat strip, the rule over the legend, the legend, and the bottom
 * border. The stat strip is added to it, because it wraps with the terminal.
 */
const OVERLAY_CHROME_ROWS = 5;

/** The chords the overlay answers, in the order the footer states them. */
const OVERLAY_LEGEND = [
	{ keys: "↑↓ j k", label: "scroll" },
	{ keys: "pgup pgdn", label: "page" },
	{ keys: "g G", label: "ends" },
	{ keys: "esc q", label: "close" },
];

export function createDashboardController(): DashboardController {
	let overlayTui: { requestRender(): void } | null = null;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let spinnerFrame = 0;

	const requestRender = (): void => {
		overlayTui?.requestRender();
	};

	const clear = (): void => {
		overlayTui = null;
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	return {
		clear(ctx): void {
			clear();
			if (ctx.hasUI) {
				ctx.ui.terminal?.setWidgetComponent("autoresearch", undefined);
			}
		},
		requestRender,
		updateWidget(ctx, runtime): void {
			if (!ctx.hasUI) return;
			const state = runtime.state;
			if (!shouldShowDashboard(runtime, state)) {
				ctx.ui.terminal?.setWidgetComponent("autoresearch", undefined);
				return;
			}

			ctx.ui.terminal?.setWidgetComponent("autoresearch", (_tui, theme) => {
				if (state.results.length === 0 && runtime.runningExperiment) {
					return new Text(renderRunningOnly(runtime, state, theme), 0, 0);
				}
				if (runtime.dashboardExpanded) {
					const width = process.stdout.columns ?? 120;
					const lines = [
						renderExpandedHeader(runtime, width, theme),
						...renderDashboardLines(runtime, width, theme, 8),
					];
					return new Text(lines.join("\n"), 0, 0);
				}
				return new Text(renderCollapsedLine(runtime, state, theme), 0, 0);
			});
		},
		async showOverlay(ctx, runtime): Promise<void> {
			if (!ctx.hasUI || !shouldShowDashboard(runtime, runtime.state)) return;
			await ctx.ui.terminal?.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					if (!spinnerTimer) {
						spinnerTimer = setInterval(() => {
							spinnerFrame += 1;
							requestRender();
						}, 80);
					}

					let scrollOffset = 0;
					// Geometry the last render settled on. Input scrolls against exactly what
					// is on screen: recomputing it here re-rendered the whole table on every
					// keystroke, and did it at the terminal width rather than the width the
					// overlay was given, so a page could step past the last row.
					let viewportRows = 1;
					let totalRows = 0;
					return {
						render(width: number): readonly string[] {
							const state = runtime.state;
							const inner = Math.max(1, width - 4);
							const title = state.name ? `autoresearch · ${replaceTabs(state.name)}` : "autoresearch";
							const stats = statStrip(dashboardStatCells(runtime), inner, theme);
							const body = renderResultTable(runtime, inner, theme, 0);
							if (runtime.runningExperiment) {
								body.push(renderOverlayRunningLine(runtime, theme, inner, spinnerFrame));
							}
							// THE BOX ENDS WHERE THE CONTENT DOES. Sizing the viewport to the
							// terminal left a five-run segment framed by twenty-five blank rows
							// inside a border drawn round them.
							const chromeRows = OVERLAY_CHROME_ROWS + stats.length;
							const available = Math.max(3, (process.stdout.rows ?? 40) - chromeRows);
							viewportRows = Math.min(available, Math.max(1, body.length));
							totalRows = body.length;
							const maxScroll = Math.max(0, body.length - viewportRows);
							if (scrollOffset > maxScroll) scrollOffset = maxScroll;
							const sv = new ScrollView(body.slice(scrollOffset, scrollOffset + viewportRows), {
								height: viewportRows,
								scrollbar: "auto",
								totalRows: body.length,
								theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
							});
							sv.setScrollOffset(scrollOffset);
							return [
								topBorder(width, title, theme),
								...stats.map(line => row(line, width, theme)),
								divider(width, theme),
								...sv.render(inner).map(line => row(line, width, theme)),
								divider(width, theme),
								row(keyLegend(OVERLAY_LEGEND, inner, theme), width, theme),
								bottomBorder(width, theme),
							];
						},
						handleInput(data: string): void {
							const maxScroll = Math.max(0, totalRows - viewportRows);
							if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
								done(undefined);
								return;
							}
							if (matchesKey(data, "up") || matchesKey(data, "k")) {
								scrollOffset = Math.max(0, scrollOffset - 1);
							} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
								scrollOffset = Math.min(maxScroll, scrollOffset + 1);
							} else if (matchesKey(data, "pageUp")) {
								scrollOffset = Math.max(0, scrollOffset - viewportRows);
							} else if (matchesKey(data, "pageDown")) {
								scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
							} else if (data === "g") {
								scrollOffset = 0;
							} else if (data === "G") {
								scrollOffset = maxScroll;
							}
							tui.requestRender();
						},
						invalidate(): void {},
						dispose(): void {
							clear();
						},
					};
				},
				{ overlay: true },
			);
		},
	};
}

function renderRunningOnly(runtime: AutoresearchRuntime, state: ExperimentState, theme: Theme): string {
	const parts = [theme.fg("accent", "autoresearch"), theme.fg("warning", " running...")];
	if (state.name) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(runtime.runningExperiment.command)}`));
	}
	return parts.join("");
}

function shouldShowDashboard(runtime: AutoresearchRuntime, state: ExperimentState): boolean {
	return (
		runtime.autoresearchMode ||
		state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

function renderExpandedHeader(runtime: AutoresearchRuntime, width: number, theme: Theme): string {
	const state = runtime.state;
	const status = renderModeStatus(runtime, state);
	const label = state.name ? ` autoresearch: ${replaceTabs(state.name)} ` : " autoresearch ";
	const hint = theme.fg(
		"dim",
		` ${AUTORESEARCH_TOGGLE_KEY} collapse  ${AUTORESEARCH_OVERLAY_KEY} overlay${status ? `  ${status}` : ""} `,
	);
	const fillWidth = Math.max(0, width - visibleWidth(label) - visibleWidth(hint));
	return truncateToWidth(theme.fg("accent", label) + theme.fg("borderMuted", "-".repeat(fillWidth)) + hint, width);
}

function renderCollapsedLine(runtime: AutoresearchRuntime, state: ExperimentState, theme: Theme): string {
	if (runtime.lastRunSummary) {
		const parts = [
			theme.fg("accent", "autoresearch"),
			theme.fg("warning", ` pending run #${runtime.lastRunSummary.runNumber}`),
			theme.fg("dim", runtime.lastRunSummary.passed ? " pass" : " fail"),
		];
		if (runtime.lastRunSummary.parsedPrimary !== null) {
			parts.push(
				theme.fg(
					"muted",
					` | ${state.metricName}=${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}`,
				),
			);
		}
		parts.push(theme.fg("warning", " | log_experiment required"));
		if (!runtime.autoresearchMode) {
			parts.push(theme.fg("dim", " | mode off"));
		}
		return parts.join("");
	}
	if (state.results.length === 0) {
		const modeStatus = runtime.autoresearchMode ? "baseline pending" : "mode off";
		const parts = [theme.fg("accent", "autoresearch"), theme.fg("warning", ` ${modeStatus}`)];
		if (state.name) {
			parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
		}
		if (runtime.autoresearchMode) {
			parts.push(theme.fg("dim", " | run the baseline"));
		}
		return parts.join("");
	}
	const current = currentResults(state.results, state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const best = findBestResult(state);
	const archivedRuns = Math.max(0, state.results.length - current.length);
	const parts = [
		theme.fg("accent", "autoresearch"),
		theme.fg("muted", ` ${current.length} runs`),
		theme.fg("success", ` ${kept} kept`),
	];
	// Only when it is doing something. A serial session has no arms to report.
	if (state.breadth > 1) parts.push(theme.fg("accent", ` breadth ${state.breadth}`));
	if (archivedRuns > 0) parts.push(theme.fg("dim", ` +${archivedRuns} archived`));
	if (crashed > 0) parts.push(theme.fg("error", ` ${crashed} crash`));
	if (checksFailed > 0) parts.push(theme.fg("error", ` ${checksFailed} checks_failed`));
	parts.push(theme.fg("dim", " | "));
	if (best && state.bestMetric !== null && best.result.metric !== state.bestMetric) {
		parts.push(theme.fg("warning", `best ${formatNum(best.result.metric, state.metricUnit)}`));
		parts.push(theme.fg("dim", ` baseline ${formatNum(state.bestMetric, state.metricUnit)}`));
	} else if (state.bestMetric !== null) {
		parts.push(theme.fg("warning", `baseline ${formatNum(state.bestMetric, state.metricUnit)}`));
	} else {
		parts.push(theme.fg("warning", `no kept runs yet`));
	}
	if (state.confidence !== null) {
		const confidenceColor = state.confidence >= 2 ? "success" : state.confidence >= 1 ? "warning" : "error";
		parts.push(theme.fg("dim", " | "));
		parts.push(theme.fg(confidenceColor, `conf ${state.confidence.toFixed(1)}x`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | running ${formatElapsed(Date.now() - runtime.runningExperiment.startedAt)}`));
	} else if (!runtime.autoresearchMode) {
		parts.push(theme.fg("dim", ` | ${renderModeStatus(runtime, state)}`));
	}
	parts.push(theme.fg("dim", ` | ${AUTORESEARCH_TOGGLE_KEY} expand`));
	return parts.join("");
}

export function renderDashboardLines(
	runtime: AutoresearchRuntime,
	width: number,
	theme: Theme,
	maxRows: number,
): string[] {
	const state = runtime.state;
	if (state.results.length === 0) {
		if (runtime.lastRunSummary) {
			const lines = [
				truncateToWidth(`Pending run: #${runtime.lastRunSummary.runNumber}`, width),
				truncateToWidth(
					`Result: ${runtime.lastRunSummary.passed ? "passed" : "failed"}${runtime.lastRunSummary.parsedPrimary !== null ? `  ${state.metricName} ${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}` : ""}`,
					width,
				),
				truncateToWidth("Next action: finish log_experiment before starting another run.", width),
			];
			if (!runtime.autoresearchMode) {
				lines.push(truncateToWidth("Mode: off", width));
			}
			return lines;
		}
		if (runtime.autoresearchMode) {
			return [
				truncateToWidth("Current segment: 0 runs", width),
				truncateToWidth("Baseline: pending", width),
				truncateToWidth("Next action: run and log the baseline experiment.", width),
			];
		}
		return [theme.fg("dim", "No experiments logged yet.")];
	}

	const cells = dashboardStatCells(runtime);
	const lines = statStrip(cells, width, theme);
	lines.push("");
	lines.push(...renderResultTable(runtime, width, theme, maxRows));
	return lines;
}

/**
 * What the current segment reads, as one strip of measurements.
 *
 * Six `Label: value` lines is what this replaced, and the run table under them was
 * pushed off a short terminal by a summary of itself. Each reading carries its own
 * tone, so a crash count is red at a glance and a zero is not.
 */
export function dashboardStatCells(runtime: AutoresearchRuntime): StatCell[] {
	const state = runtime.state;
	const current = currentResults(state.results, state.currentSegment);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const cells: StatCell[] = [{ label: "runs", value: String(current.length) }];
	const kept = current.filter(result => result.status === "keep").length;
	const discarded = current.filter(result => result.status === "discard").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	cells.push({ label: "kept", value: String(kept), tone: kept > 0 ? "success" : "muted" });
	// A zero is not news. Only a count that happened earns a cell, so the strip is
	// short on a clean segment and says what went wrong on a bad one.
	if (discarded > 0) cells.push({ label: "discarded", value: String(discarded), tone: "warning" });
	if (crashed > 0) cells.push({ label: "crashed", value: String(crashed), tone: "error" });
	if (checksFailed > 0) cells.push({ label: "checks failed", value: String(checksFailed), tone: "error" });
	const archived = state.results.length - current.length;
	if (archived > 0) cells.push({ label: "archived", value: String(archived), tone: "muted" });
	cells.push({
		label: "baseline",
		value: `${formatNum(baseline, state.metricUnit)}${baselineRunNumber ? ` #${baselineRunNumber}` : ""}`,
		tone: "text",
	});
	if (best) {
		const bestRunNumber = best.result.runNumber ?? best.index + 1;
		const change = formatPercentChange(best.result.metric, baseline);
		cells.push({
			label: "best",
			value: `${formatNum(best.result.metric, state.metricUnit)} #${bestRunNumber}${change ? ` ${change}` : ""}`,
			tone: "success",
		});
		if (state.confidence !== null) {
			cells.push({
				label: "confidence",
				value: `${state.confidence.toFixed(1)}x`,
				tone: state.confidence >= 2 ? "success" : state.confidence >= 1 ? "warning" : "error",
			});
		}
		for (const metric of state.secondaryMetrics) {
			const value = best.result.metrics[metric.name];
			if (value === undefined) continue;
			const change = formatPercentChange(value, baselineSecondary[metric.name]);
			cells.push({
				label: metric.name,
				value: `${formatNum(value, metric.unit)}${change ? ` ${change}` : ""}`,
				tone: "muted",
			});
		}
	}
	if (runtime.lastRunSummary) {
		cells.push({
			label: "pending",
			value: `#${runtime.lastRunSummary.runNumber} ${runtime.lastRunSummary.passed ? "passed" : "failed"}, log_experiment required`,
			tone: "warning",
		});
	}
	if (!runtime.autoresearchMode) {
		cells.push({ label: "mode", value: renderModeStatus(runtime, state), tone: "muted" });
	}
	return cells;
}

/**
 * The run table: a heading, a rule, and one row per run in the current segment.
 *
 * COLUMNS ARE MEASURED, NOT DECLARED. The widths were the constants 4, 10, 12, 14
 * and a per-cell cap of 10, so a metric that formatted to eleven characters ran into
 * the column beside it, every secondary reading was cut to `511.90ms …` with forty
 * percent of the terminal unused, and a `commit` column ten wide held a dash for
 * every row of a session that logs no commits. Each column is now as wide as the
 * widest thing in it, the description takes what is left, and a column whose every
 * cell is empty is not drawn.
 */
function renderResultTable(runtime: AutoresearchRuntime, width: number, theme: Theme, maxRows: number): string[] {
	const state = runtime.state;
	const current = currentResults(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	const rows = visible.map(result => ({
		number: String(result.runNumber ?? state.results.indexOf(result) + 1),
		commit: result.commit || "",
		// A crash produced no measurement. `state.results` carries 0 for a missing
		// metric, so printing it renders `0ms` beside a `-` in every secondary
		// column of the same row, and the fastest run in the table is the one that
		// never ran.
		metric: result.status === "crash" ? "-" : formatNum(result.metric, state.metricUnit),
		secondary: state.secondaryMetrics.map(metric =>
			renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]),
		),
		status: result.status,
		description: replaceTabs(result.description),
		tone: statusTone(result.status),
	}));
	const showCommit = rows.some(row => row.commit.length > 0);
	const columns: number[] = [
		measure(
			rows.map(row => row.number),
			"#",
		),
		...(showCommit
			? [
					measure(
						rows.map(row => row.commit),
						"commit",
					),
				]
			: []),
		measure(
			rows.map(row => row.metric),
			state.metricName,
		),
		...state.secondaryMetrics.map((metric, index) =>
			measure(
				rows.map(row => row.secondary[index] ?? ""),
				metric.name,
			),
		),
		measure(
			rows.map(row => row.status),
			"status",
		),
	];
	// The description takes whatever the measured columns left, floored so a narrow
	// terminal shows a stub of it rather than dropping the column and its heading.
	const fixed = columns.reduce((total, column) => total + column + COLUMN_GAP, 0);
	const descriptionWidth = Math.max(MIN_DESCRIPTION, width - fixed);
	const heading = [
		theme.fg("muted", "#".padEnd(columns[0])),
		...(showCommit ? [theme.fg("muted", "commit".padEnd(columns[1]))] : []),
		theme.fg("warning", state.metricName.padEnd(columns[showCommit ? 2 : 1])),
		...state.secondaryMetrics.map((metric, index) =>
			theme.fg("muted", metric.name.padEnd(columns[(showCommit ? 3 : 2) + index])),
		),
		theme.fg("muted", "status".padEnd(columns[columns.length - 1])),
		theme.fg("muted", "description"),
	].join(GAP);
	const lines = [
		truncateToWidth(heading, width),
		theme.fg("borderMuted", theme.boxSharp.horizontal.repeat(Math.max(0, width))),
	];
	if (visible.length < current.length) {
		lines.push(theme.fg("dim", `${current.length - visible.length} earlier runs hidden`));
	}
	for (const row of rows) {
		const cells = [
			theme.fg("dim", row.number.padEnd(columns[0])),
			...(showCommit ? [theme.fg("accent", row.commit.padEnd(columns[1]))] : []),
			theme.fg(row.tone, row.metric.padEnd(columns[showCommit ? 2 : 1])),
			...row.secondary.map((cell, index) => theme.fg("muted", cell.padEnd(columns[(showCommit ? 3 : 2) + index]))),
			theme.fg(row.tone, row.status.padEnd(columns[columns.length - 1])),
			theme.fg("muted", truncateToWidth(row.description, descriptionWidth)),
		];
		lines.push(truncateToWidth(cells.join(GAP), width));
	}
	return lines;
}

/** Gap between two table columns, as a width and as the string that fills it. */
const COLUMN_GAP = 2;
const GAP = " ".repeat(COLUMN_GAP);
/** Columns a description keeps even when the measured columns have eaten the width. */
const MIN_DESCRIPTION = 12;

/** Width of a column: its heading, or its widest cell, whichever is longer. */
function measure(cells: readonly string[], heading: string): number {
	let widest = heading.length;
	for (const cell of cells) widest = Math.max(widest, cell.length);
	return widest;
}

function statusTone(status: string): ThemeColor {
	if (status === "keep") return "success";
	if (status === "discard") return "warning";
	return "error";
}

function renderSecondaryCell(value: number | undefined, unit: string, baseline: number | undefined): string {
	if (value === undefined) return "-";
	const formatted = formatNum(value, unit);
	const change = formatPercentChange(value, baseline);
	return change ? `${formatted} ${change}` : formatted;
}

function renderOverlayRunningLine(
	runtime: AutoresearchRuntime,
	theme: Theme,
	width: number,
	spinnerFrame: number,
): string {
	const spinner = theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length] ?? "*";
	return truncateToWidth(
		theme.fg(
			"warning",
			`${spinner} running ${formatElapsed(Date.now() - (runtime.runningExperiment?.startedAt ?? Date.now()))} ${replaceTabs(
				runtime.runningExperiment?.command ?? "",
			)}`,
		),
		width,
	);
}

function renderModeStatus(runtime: AutoresearchRuntime, state: ExperimentState): string {
	if (runtime.autoresearchMode) {
		return state.results.length === 0 ? "baseline pending" : "mode on";
	}
	const current = currentResults(state.results, state.currentSegment);
	if (state.maxExperiments !== null && current.length >= state.maxExperiments) {
		return "segment complete";
	}
	return "mode off";
}

function findBestResult(state: ExperimentState): { index: number; result: ExperimentResult } | null {
	let best: { index: number; result: ExperimentResult } | null = null;
	for (let index = 0; index < state.results.length; index += 1) {
		const result = state.results[index];
		if (result.segment !== state.currentSegment || result.status !== "keep" || result.metric <= 0) continue;
		if (!best || isBetter(result.metric, best.result.metric, state.bestDirection)) {
			best = { index, result };
		}
	}
	return best;
}
