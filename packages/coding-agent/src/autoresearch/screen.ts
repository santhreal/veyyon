/**
 * The autoresearch / autoswarm run screen: one surface that owns a loop.
 *
 * Reached with the extension's own chord, it is the `/advisor configure` idiom —
 * a two-pane {@link ./overlay-box} card whose sidebar is a {@link SelectList} of
 * everything the session has produced and whose body is the highlighted entry in
 * full. The session, the injected playbook, the run in flight and every logged
 * run are rows in one list, so reading a loop is scrolling, not remembering
 * which chord shows which slice.
 *
 * Row geometry lives in `renderRunScreen`, which takes its width and height as
 * arguments so a test can pin a frame without a terminal.
 */
import { type Component, type SelectItem, SelectList, sanitizeSingleLine, truncateToWidth } from "@veyyon/tui";
import { clampLow } from "@veyyon/utils";
import {
	bottomBorder,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorderSplit,
} from "../modes/components/overlay-box";
import { getSelectListTheme, type ThemeColor, theme } from "../modes/theme/theme";
import { shortenPath } from "../tools/shorten-path";
import { formatElapsed, formatNum, formatPercentChange } from "./helpers";
import {
	currentResults,
	effectiveBreadth,
	findBaselineMetric,
	findBaselineRunNumber,
	findBaselineSecondary,
} from "./state";
import type { AutoresearchRuntime, ExperimentResult, ExperimentState } from "./types";

/** Label column of the detail body, so every value starts at one column. */
const LABEL_WIDTH = 12;

/** Sidebar bounds. Wide enough for `#1234  192.78ms`, never past a third. */
const SIDEBAR_MIN = 22;
const SIDEBAR_MAX = 34;

const FOOTER_HINT = "up/down select   pgup/pgdn page   esc close";
/**
 * Shortest frame the card can be: four chrome rows (title border, divider,
 * footer, bottom border) around the three-row body floor. The clamp used to be
 * 14, which wrote eight rows more than a ten-row terminal had — the same defect
 * on the screen that the widget had above the composer.
 */
const SCREEN_MIN_ROWS = 7;

/**
 * Soft-wrap plain text, returning at least one (possibly empty) line.
 *
 * Every value in this pane is text a model wrote into the session — a
 * description, a note, a flag reason, a commit subject — so it is sanitized
 * first: a literal tab lands on the terminal's own tab stops and opens a hole
 * through the pane's columns, and an embedded newline pushes a row past the
 * border the caller measured.
 */
function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(sanitizeSingleLine(text), Math.max(1, width), { trim: false }).split("\n");
}

/** `Label       value`, wrapped under a hanging indent so values stay in column. */
function field(label: string, value: string, width: number): string[] {
	const body = Math.max(1, width - LABEL_WIDTH);
	const lines = wrap(value, body);
	return lines.map((line, index) =>
		index === 0 ? `${theme.fg("dim", label.padEnd(LABEL_WIDTH))}${line}` : `${" ".repeat(LABEL_WIDTH)}${line}`,
	);
}

function statusPaint(status: ExperimentResult["status"], flagged: boolean): ThemeColor {
	if (flagged) return "warning";
	return status === "keep" ? "success" : status === "discard" ? "muted" : "error";
}

/** What a run row reports as its outcome: the verdict outranks the status. */
export function runOutcome(result: ExperimentResult): string {
	return result.flagged ? "flagged" : result.status;
}

/**
 * What a run's metric column says.
 *
 * A crash that produced no measurement still has to log a number, because
 * `log_experiment` requires one, so the loop records the only number it has:
 * zero. Formatted like any other value that read `#6  0ms` in a session where
 * lower is better — the fastest row on the screen was the run that segfaulted.
 * Best and baseline math already skips a crash, so this is the display saying
 * what the number is worth.
 *
 * A harness that printed its metric and then died did measure, and that number
 * is the one the run is worth reading for: it comes from the harness's own
 * output rather than from the logged placeholder.
 */
export function metricLabel(result: ExperimentResult, unit: string): string {
	if (result.status !== "crash") return formatNum(result.metric, unit);
	return result.measuredPrimary === null ? "no metric" : formatNum(result.measuredPrimary, unit);
}

export function screenTitle(runtime: AutoresearchRuntime): string {
	const state = runtime.state;
	// The name and the goal are model-written text, and this one is inset into a
	// border: a tab or a newline in it breaks the row the card is measured by.
	const named = state.name ?? state.goal ?? runtime.goal;
	const name = named ? sanitizeSingleLine(named) : null;
	// The breadth the console chose, not only the breadth the stored session has:
	// a fresh autoswarm spends its first turn with a state that reads breadth 1,
	// and titling that surface "Autoresearch" names the wrong loop.
	const label = effectiveBreadth(runtime) > 1 ? "Autoswarm" : "Autoresearch";
	const mode = runtime.autoresearchMode ? "" : "  (mode off)";
	return name ? `${label} · ${name}${mode}` : `${label}${mode}`;
}

/**
 * Sidebar rows, newest first, grouped by segment.
 *
 * The session and the playbook are rows rather than a banner: a banner is paid
 * for on every frame by every reader, and these two are read once each.
 */
export function runScreenRows(runtime: AutoresearchRuntime): SelectItem[] {
	const state = runtime.state;
	const rows: SelectItem[] = [
		{ value: "session", label: "Session", description: sessionRowSummary(runtime), group: "overview" },
		{ value: "notes", label: "Playbook", description: notesSummary(state), group: "overview" },
	];
	if (runtime.runningExperiment) {
		// No elapsed time on this row. The list is rebuilt whenever its rows change,
		// and a rebuilt list is a fresh one: a clock here changed the rows once a
		// second, so a filter the reader had typed vanished on the next tick. The
		// elapsed time is on the status row and in this row's detail pane, both of
		// which are painted from scratch on every frame.
		rows.push({
			value: "running",
			label: `#${runtime.runningExperiment.runNumber}  running`,
			description: "in flight",
			group: "overview",
		});
	} else if (runtime.lastRunSummary) {
		rows.push({
			value: "pending",
			label: `#${runtime.lastRunSummary.runNumber}  pending`,
			description: runtime.lastRunSummary.passed ? "log required" : "failed",
			group: "overview",
		});
	}
	for (let index = state.results.length - 1; index >= 0; index -= 1) {
		const result = state.results[index];
		const number = result.runNumber ?? index + 1;
		const arm = result.arm ? `  ${result.arm}` : "";
		rows.push({
			value: `run:${number}`,
			label: `#${number}  ${metricLabel(result, state.metricUnit)}`,
			description: `${runOutcome(result)}${arm}`,
			group: `segment ${result.segment + 1}`,
			filterText: `${number} ${result.description} ${result.arm ?? ""}`,
		});
	}
	return rows;
}

function sessionRowSummary(runtime: AutoresearchRuntime): string {
	const state = runtime.state;
	if (state.results.length === 0) return runtime.autoresearchMode ? "baseline pending" : "not started";
	const kept = currentResults(state.results, state.currentSegment).filter(r => r.status === "keep").length;
	return `${state.results.length} runs  ${kept} kept`;
}

function notesSummary(state: ExperimentState): string {
	const text = state.notes.trim();
	if (text.length === 0) return "empty";
	return `${text.split("\n").filter(line => line.trim().length > 0).length} lines`;
}

/** The highlighted row in full. */
export function renderRunDetail(runtime: AutoresearchRuntime, value: string, width: number): string[] {
	if (value === "notes") return notesDetail(runtime.state, width);
	if (value === "pending" || value === "running") return pendingDetail(runtime, width);
	const match = /^run:(\d+)$/.exec(value);
	if (match) {
		const number = Number(match[1]);
		const result = runtime.state.results.find((candidate, index) => (candidate.runNumber ?? index + 1) === number);
		if (result) return runDetail(result, runtime.state, width);
	}
	return sessionDetail(runtime, width);
}

function sessionDetail(runtime: AutoresearchRuntime, width: number): string[] {
	const state = runtime.state;
	const current = currentResults(state.results, state.currentSegment);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRun = findBaselineRunNumber(state.results, state.currentSegment);
	const best = bestResult(state);
	const lines: string[] = [];
	// The title carries the name too, and the title is inset into a border segment
	// as wide as the sidebar, so a long name reads in full only here.
	if (state.name) lines.push(...field("Session", state.name, width));
	lines.push(...field("Goal", runtime.goal ?? state.goal ?? "(not stated)", width));
	lines.push(
		...field(
			"Metric",
			`${state.metricName}  ${state.bestDirection === "lower" ? "lower" : "higher"} is better`,
			width,
		),
	);
	lines.push("");
	lines.push(
		...field(
			"Baseline",
			baseline === null
				? "pending"
				: `${formatNum(baseline, state.metricUnit)}${baselineRun ? `  (#${baselineRun})` : ""}`,
			width,
		),
	);
	if (best) {
		const change = formatPercentChange(best.metric, baseline);
		lines.push(
			...field(
				"Best",
				`${formatNum(best.metric, state.metricUnit)}  (#${best.runNumber ?? "?"})${change ? `  ${change}` : ""}`,
				width,
			),
		);
	}
	if (state.confidence !== null) lines.push(...field("Confidence", `${state.confidence.toFixed(1)}x`, width));
	lines.push("");
	lines.push(
		...field(
			"Segment",
			`${state.currentSegment + 1}  ·  ${current.length} runs  ${countBy(current, "keep")} kept  ${countBy(current, "discard")} discarded  ${countBy(current, "crash")} crashed  ${countBy(current, "checks_failed")} checks failed`,
			width,
		),
	);
	if (state.results.length > current.length) {
		lines.push(...field("Archived", `${state.results.length - current.length} runs from earlier segments`, width));
	}
	lines.push("");
	const breadth = effectiveBreadth(runtime);
	if (breadth > 1) {
		lines.push(...field("Breadth", `${breadth} arms per iteration`, width));
		const flagged = state.results.filter(result => result.flagged).length;
		lines.push(...field("Flagged", flagged === 0 ? "none" : `${flagged} runs`, width));
	} else {
		lines.push(...field("Breadth", "1  ·  serial, no arms and no review", width));
	}
	if (state.maxExperiments !== null) lines.push(...field("Cap", `${state.maxExperiments} runs per segment`, width));
	lines.push("");
	lines.push(...field("Scope", state.scopePaths.length > 0 ? state.scopePaths.join(", ") : "(unset)", width));
	lines.push(...field("Off limits", state.offLimits.length > 0 ? state.offLimits.join(", ") : "(unset)", width));
	if (state.constraints.length > 0) lines.push(...field("Constraints", state.constraints.join(", "), width));
	lines.push(
		...field(
			"Branch",
			state.branch
				? `${state.branch}${state.baselineCommit ? ` @ ${state.baselineCommit.slice(0, 12)}` : ""}`
				: "(current branch)",
			width,
		),
	);
	return lines;
}

function countBy(results: readonly ExperimentResult[], status: ExperimentResult["status"]): number {
	return results.filter(result => result.status === status).length;
}

function bestResult(state: ExperimentState): ExperimentResult | null {
	let best: ExperimentResult | null = null;
	for (const result of currentResults(state.results, state.currentSegment)) {
		if (result.status !== "keep" || result.flagged || result.metric <= 0) continue;
		if (
			best === null ||
			(state.bestDirection === "lower" ? result.metric < best.metric : result.metric > best.metric)
		) {
			best = result;
		}
	}
	return best;
}

function notesDetail(state: ExperimentState, width: number): string[] {
	const lines = [theme.fg("dim", "Injected into the model's context on every iteration."), ""];
	const text = state.notes.trim();
	if (text.length === 0) {
		lines.push(theme.fg("muted", "Empty. The loop writes this with update_notes."));
		return lines;
	}
	for (const paragraph of text.split("\n")) lines.push(...wrap(paragraph, width));
	return lines;
}

function pendingDetail(runtime: AutoresearchRuntime, width: number): string[] {
	const state = runtime.state;
	const running = runtime.runningExperiment;
	if (running) {
		return [
			...field("Run", `#${running.runNumber}  running ${formatElapsed(Date.now() - running.startedAt)}`, width),
			...field("Command", running.command, width),
			// The run directory sits under the profile, so the untouched string states the operator's home
			// directory and account name on a screen a demo or a screenshot carries out of the session.
			...field("Artifacts", shortenPath(running.runDirectory), width),
		];
	}
	const pending = runtime.lastRunSummary;
	if (!pending) return [theme.fg("muted", "No run in flight.")];
	const lines = [
		...field("Run", `#${pending.runNumber}  ${pending.passed ? "passed" : "failed"}`, width),
		...field("Command", pending.command, width),
	];
	if (pending.parsedPrimary !== null) {
		lines.push(...field(state.metricName, formatNum(pending.parsedPrimary, state.metricUnit), width));
	}
	if (pending.durationSeconds !== null)
		lines.push(...field("Duration", `${pending.durationSeconds.toFixed(1)}s`, width));
	if (pending.exitCode !== null) lines.push(...field("Exit", String(pending.exitCode), width));
	if (pending.timedOut) lines.push(...field("Timed out", "yes", width));
	lines.push(...field("Artifacts", shortenPath(pending.runDirectory), width));
	lines.push("");
	lines.push(theme.fg("warning", "Not logged yet: the loop owes this run a log_experiment."));
	return lines;
}

function runDetail(result: ExperimentResult, state: ExperimentState, width: number): string[] {
	// The run's own segment, not the current one: an archived run was judged
	// against the baseline of the segment it ran in, and a percentage against a
	// later segment's baseline describes a comparison the loop never made.
	const baseline = findBaselineMetric(state.results, result.segment);
	const baselineSecondary = findBaselineSecondary(state.results, result.segment, state.secondaryMetrics);
	// The comparison is against the number the row shows: a crash that measured
	// nothing has none, and reading its logged zero against a 205ms baseline
	// printed `0ms  -100.0%`, a claim about a run that never finished.
	const shown = result.status === "crash" ? result.measuredPrimary : result.metric;
	const change = shown === null ? undefined : formatPercentChange(shown, baseline);
	const lines: string[] = [];
	lines.push(
		...field(
			"Outcome",
			theme.fg(statusPaint(result.status, result.flagged), runOutcome(result)) +
				(result.flagged ? theme.fg("dim", ` (logged ${result.status})`) : ""),
			width,
		),
	);
	lines.push(
		...field(state.metricName, `${metricLabel(result, state.metricUnit)}${change ? `  ${change}` : ""}`, width),
	);
	for (const metric of state.secondaryMetrics) {
		const value = result.metrics[metric.name];
		if (value === undefined) continue;
		const delta = formatPercentChange(value, baselineSecondary[metric.name]);
		lines.push(...field(metric.name, `${formatNum(value, metric.unit)}${delta ? `  ${delta}` : ""}`, width));
	}
	if (result.confidence !== null) lines.push(...field("Confidence", `${result.confidence.toFixed(1)}x`, width));
	lines.push("");
	if (result.arm !== null || result.certifiedBy !== null) {
		lines.push(...field("Arm", result.arm ?? "(unattributed)", width));
		lines.push(...field("Reviewed by", result.certifiedBy ?? "(nobody)", width));
	}
	if (result.flagged) {
		lines.push(...field("Flagged", theme.fg("warning", result.flaggedReason ?? "no reason recorded"), width));
		lines.push(
			...field("", theme.fg("dim", "A flagged run is excluded from the baseline and the best metric."), width),
		);
	}
	if (result.scopeDeviations.length > 0) {
		lines.push(...field("Off limits", theme.fg("warning", result.scopeDeviations.join(", ")), width));
		lines.push(
			...field("Justified", result.justification ?? theme.fg("warning", "no justification recorded"), width),
		);
	}
	lines.push("");
	lines.push(...field("Change", result.description || "(no description)", width));
	if (result.commit) lines.push(...field("Commit", result.commit, width));
	if (result.modifiedPaths.length > 0) lines.push(...field("Files", result.modifiedPaths.join(", "), width));
	const asi = result.asi;
	if (asi && Object.keys(asi).length > 0) {
		const entries = Object.entries(asi).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
		lines.push(...field("ASI", entries.join("  "), width));
	}
	return lines;
}

/**
 * The whole card: `rows` lines exactly, so the host never has to guess how tall
 * the screen came out.
 */
export function renderRunScreen(
	runtime: AutoresearchRuntime,
	width: number,
	rows: number,
	sidebar: readonly string[],
	detail: readonly string[],
	sidebarWidth: number,
): string[] {
	const bodyRows = Math.max(3, rows - 4);
	const out: string[] = [topBorderSplit(width, screenTitle(runtime), sidebarWidth)];
	for (let index = 0; index < bodyRows; index += 1) {
		out.push(splitRow(sidebar[index] ?? "", detail[index] ?? "", width, sidebarWidth));
	}
	out.push(dividerSplit(width, sidebarWidth));
	out.push(row(theme.fg("dim", FOOTER_HINT), width));
	out.push(bottomBorder(width));
	// The chrome has a floor of its own — two borders and the insets between
	// them — so a terminal narrower than that still gets rows it can print.
	return out.map(line => truncateToWidth(line, width));
}

/**
 * Sidebar column width for a card of `width` columns.
 *
 * Two panes cost seven columns of chrome, so a sidebar sized only by its own
 * bounds wrote a 29-column frame into a 10-column terminal and the border
 * wrapped. A terminal that cannot pay for the sidebar's floor and one body
 * column gives the sidebar whatever is left instead.
 */
export function screenSidebarWidth(width: number): number {
	const wanted = clampLow(Math.floor(width * 0.28), SIDEBAR_MIN, SIDEBAR_MAX);
	return clampLow(wanted, 0, width - 8);
}

/**
 * What the sidebar is showing, as one string. A screen open across a logged run
 * rebuilds its list only when this changes, so an idle repaint allocates one
 * string instead of a list.
 */
function signatureOf(items: readonly SelectItem[]): string {
	return items.map(item => `${item.value}|${item.description ?? ""}`).join("\n");
}

/**
 * Live screen. Rebuilds its list whenever the loop's data changed, keeping the
 * highlighted row: a run logged while the screen is open must not move the
 * reader's cursor onto a different run.
 */
export class AutoresearchScreenComponent implements Component {
	#runtime: AutoresearchRuntime;
	#close: () => void;
	#requestRender: () => void;
	#rows: () => number;
	#list: SelectList;
	#selected = "session";
	#signature = "";
	#detailScroll = 0;
	/** Last sidebar width, so the group rule is drawn to the column it lives in. */
	#sidebarWidth = SIDEBAR_MIN;
	/** Rows the detail pane last showed, so a page key moves by a viewport. */
	#detailRows = 1;

	constructor(options: {
		runtime: AutoresearchRuntime;
		close: () => void;
		requestRender: () => void;
		rows: () => number;
	}) {
		this.#runtime = options.runtime;
		this.#close = options.close;
		this.#requestRender = options.requestRender;
		this.#rows = options.rows;
		this.#list = this.#buildList(runScreenRows(this.#runtime));
	}

	#buildList(items: SelectItem[]): SelectList {
		this.#signature = signatureOf(items);
		const listTheme = {
			...getSelectListTheme(),
			// The shared group paint draws a fixed 30-column rule, which is wider
			// than this sidebar and arrived clipped with an ellipsis on every
			// heading. Same colour, same shape, measured against the column.
			groupHeader: (name: string): string => {
				const text = name.toUpperCase();
				const rule = Math.max(1, this.#sidebarWidth - text.length - 3);
				return theme.fg("borderAccent", `  ${text} ${"─".repeat(rule)}`);
			},
		};
		const list = new SelectList(items, Math.max(3, this.#rows() - 4), listTheme);
		const index = items.findIndex(item => item.value === this.#selected);
		list.setSelectedIndex(index >= 0 ? index : 0);
		list.onSelectionChange = item => {
			this.#selected = item.value;
			this.#detailScroll = 0;
		};
		list.onCancel = () => this.#close();
		return list;
	}

	/**
	 * Push new rows only when the rows themselves changed, so an idle repaint
	 * costs one string. The list is updated rather than replaced: a reader who
	 * filtered the sidebar keeps their filter and their selected run across a run
	 * being logged.
	 */
	#sync(): void {
		const items = runScreenRows(this.#runtime);
		const signature = signatureOf(items);
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#list.setItems(items);
	}

	render(width: number): readonly string[] {
		this.#sync();
		const rows = Math.max(SCREEN_MIN_ROWS, this.#rows());
		const bodyRows = Math.max(3, rows - 4);
		const sidebarWidth = screenSidebarWidth(width);
		this.#sidebarWidth = sidebarWidth;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		this.#list.setRowBudget(bodyRows);
		const sidebar = this.#list.render(sidebarWidth);
		this.#detailRows = bodyRows;
		const detail = this.#detailWindow(bodyWidth, bodyRows);
		return renderRunScreen(this.#runtime, width, rows, sidebar, detail, sidebarWidth);
	}

	/**
	 * The detail pane, windowed to `bodyRows`. An overflowing pane spends its last
	 * row on the indicator rather than writing over a content line, so paging
	 * through a long run detail never skips a field.
	 */
	#detailWindow(bodyWidth: number, bodyRows: number): string[] {
		const lines = renderRunDetail(this.#runtime, this.#selected, bodyWidth).map(line =>
			truncateToWidth(line, bodyWidth),
		);
		if (lines.length <= bodyRows) return lines;
		const windowRows = Math.max(1, bodyRows - 1);
		const maxScroll = lines.length - windowRows;
		if (this.#detailScroll > maxScroll) this.#detailScroll = maxScroll;
		const window = lines.slice(this.#detailScroll, this.#detailScroll + windowRows);
		const remaining = maxScroll - this.#detailScroll;
		window.push(theme.fg("dim", remaining > 0 ? `↓ ${remaining} more` : "(end)"));
		return window;
	}

	handleInput(data: string): void {
		if (data === "\x1b") {
			// A reader who filtered the run list gets their filter back first: the
			// list states whether Escape has a filter to clear, and one that closed
			// the whole screen instead read a filter as "leave".
			if (this.#list.hasActiveFilter()) {
				this.#list.handleInput(data);
				this.#requestRender();
				return;
			}
			this.#close();
			return;
		}
		// The detail pane pages with the page keys; the list owns the arrows and
		// every printable character, which is its filter, so no letter is a chord
		// here. A page is the pane's own height less the indicator row it spends.
		const page = Math.max(1, this.#detailRows - 1);
		if (data === "\x1b[5~") {
			this.#detailScroll = Math.max(0, this.#detailScroll - page);
			this.#requestRender();
			return;
		}
		if (data === "\x1b[6~") {
			this.#detailScroll += page;
			this.#requestRender();
			return;
		}
		this.#list.handleInput(data);
		this.#requestRender();
	}
}
