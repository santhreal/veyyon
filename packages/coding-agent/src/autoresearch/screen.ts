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
 * Row geometry is in `renderRunScreen`, which takes its width and height as
 * arguments so a test can pin a frame without a terminal.
 */
import { type Component, type SelectItem, SelectList, sanitizeSingleLine, truncateToWidth } from "@veyyon/tui";
import { clampLow } from "@veyyon/utils";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
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
	findBestKeptResult,
} from "./state";
import type { AutoresearchRuntime, ExperimentResult, ExperimentState } from "./types";

/** Label column of the detail body, so every value starts at one column. */
const LABEL_WIDTH = 12;

/**
 * Sidebar bounds. Wide enough for the full ledger row — `#12 c  192.78ms
 * -6.4%  best` — because a row that sheds its outcome tag at every reachable
 * terminal width is a column that does not exist. Never past a third of the
 * card, so the detail pane stays the larger of the two.
 */
const SIDEBAR_MIN = 22;
const SIDEBAR_MAX = 40;

/**
 * Footer hints, widest first. The row is truncated to the card, so one long
 * string lost its tail: below 29 columns the card cut `esc close` off and the
 * screen stated no way out of itself. Each entry is a whole hint, and the
 * widest one that fits is the one printed, so the exit is the last thing shed
 * rather than the first.
 */
const FOOTER_HINTS = [
	"up/down select   pgup/pgdn page   esc close",
	"up/down   pgup/pgdn   esc close",
	"esc close",
	"esc",
];
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

/**
 * `Label       value`, wrapped under a hanging indent so values stay in column.
 *
 * A continuation line is trimmed at the front. The wrapper keeps the space it
 * broke on, so a value that wrapped started one column right of the value above
 * it and the hanging indent stopped hanging. Indentation inside a value is not
 * lost by this: `sanitizeSingleLine` has already collapsed it, and the one
 * caller with meaningful indentation -- the playbook -- wraps directly.
 */
function field(label: string, value: string, width: number): string[] {
	const body = Math.max(1, width - LABEL_WIDTH);
	const lines = wrap(value, body);
	return lines.map((line, index) =>
		index === 0
			? `${theme.fg("dim", label.padEnd(LABEL_WIDTH))}${line}`
			: `${" ".repeat(LABEL_WIDTH)}${line.trimStart()}`,
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
 * What a run's metric column contains.
 *
 * A crash that produced no measurement still has to log a number, because
 * `log_experiment` requires one, so the loop records the only number it has:
 * zero. Formatted like any other value that read `#6  0ms` in a session where
 * lower is better — the fastest row on the screen was the run that segfaulted.
 * Best and baseline math already skips a crash, so this is where the display
 * states what the number is worth.
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
	// A pause is the state the status row already reports; the screen reads the
	// same one, so `esc` mid-turn does not leave a title that reads as running.
	const paused = runtime.interrupted || runtime.pausedOnBranch !== null;
	const mode = runtime.autoresearchMode ? (paused ? "  (paused)" : "") : "  (mode off)";
	return name ? `${label} · ${name}${mode}` : `${label}${mode}`;
}

/**
 * The tag a run row carries: what that run is worth to the reader.
 *
 * `best` and `base` are the two rows the whole segment is read against, and
 * the other four state why a run is in neither of those roles. A run that was
 * kept and is neither is `kept`.
 *
 * Four characters each but one, which is what lets the column survive the shed
 * ladder on an ordinary terminal: `dropped` and `flagged` cost the whole column
 * two more, and a verdict nobody sees is worth less than an abbreviated one.
 *
 * `base` outranks `best` on the run that is both. Early in a segment the
 * baseline is also the leader, and tagging it `best` puts a winner on a list
 * that has not produced one; with no row tagged `best`, the absence is the
 * reading, and it is the true one.
 */
function runTag(result: ExperimentResult, isBest: boolean, isBaseline: boolean): string {
	if (result.flagged) return "flag";
	if (result.status === "crash") return "crash";
	if (result.status === "checks_failed") return "fail";
	if (result.status === "discard") return "drop";
	if (isBaseline) return "base";
	if (isBest) return "best";
	return "kept";
}

/** A run row before it is measured against its neighbours and padded to them. */
interface RunRow {
	value: string;
	segment: number;
	number: string;
	metric: string;
	delta: string;
	tag: string;
	filterText: string;
}

/**
 * Sidebar rows, newest first, grouped by segment.
 *
 * A run list is read by scanning it, not by selecting each row in turn and
 * reading the pane beside it, so a row states its own verdict. Four columns,
 * padded against each other so they read as a ledger rather than as ragged
 * text: which run it was, its metric, its change against the baseline of its
 * own segment, and what it is worth. A swarm run carries its arm next to its
 * number — `#12 c` — because in a breadth of four the number alone does not
 * identify the candidate that produced the reading.
 *
 * The columns shed from the right as the sidebar narrows, in the order the rest
 * of this screen sheds: the same ladder the footer hint and the status row use.
 * The tag goes first, then the change, and the narrowest sidebar is the bare
 * number the detail pane then has to answer for.
 *
 * No row carries a `description`. `SelectList` prints one only above 40 columns
 * and this sidebar is capped at 40, so every description here was computed on
 * every frame, keyed the list's rebuild signature, and rendered nowhere. A row
 * states everything it has to state in its label.
 */
export function runScreenRows(runtime: AutoresearchRuntime, sidebarWidth: number = SIDEBAR_MAX): SelectItem[] {
	const state = runtime.state;
	const rows: SelectItem[] = [
		{ value: "session", label: "Session", group: "overview" },
		{ value: "notes", label: "Playbook", group: "overview" },
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
			group: "overview",
		});
	} else if (runtime.lastRunSummary) {
		// `pending` alone stated nothing about the run. The decision at this point
		// is whether the change is worth logging, and the harness result is half of
		// it.
		rows.push({
			value: "pending",
			label: `#${runtime.lastRunSummary.runNumber}  ${runtime.lastRunSummary.passed ? "passed" : "failed"}, unlogged`,
			group: "overview",
		});
	}
	// One pass per segment rather than one per row: the baseline and the best of a
	// segment are the same two lookups for every run in it.
	const baselines = new Map<number, number | null>();
	const bests = new Map<number, ExperimentResult | null>();
	const runRows: RunRow[] = [];
	for (let index = state.results.length - 1; index >= 0; index -= 1) {
		const result = state.results[index];
		const segment = result.segment;
		if (!baselines.has(segment)) {
			baselines.set(segment, findBaselineMetric(state.results, segment));
			bests.set(segment, findBestKeptResult(state.results, segment, state.bestDirection));
		}
		const baseline = baselines.get(segment) ?? null;
		const number = result.runNumber ?? index + 1;
		const isBaseline = findBaselineRunNumber(state.results, segment) === number;
		const isBest = bests.get(segment) === result;
		// The change a crash shows is the change of the number it shows: a run that
		// measured nothing is compared against nothing, and the baseline row is the
		// reference rather than a reading of it.
		const shown = result.status === "crash" ? result.measuredPrimary : result.metric;
		const delta = isBaseline || shown === null ? undefined : formatPercentChange(shown, baseline);
		runRows.push({
			value: `run:${number}`,
			segment,
			number: result.arm ? `#${number} ${result.arm}` : `#${number}`,
			metric: metricLabel(result, state.metricUnit),
			delta: delta ?? "",
			tag: runTag(result, isBest, isBaseline),
			filterText: `${number} ${result.description} ${result.arm ?? ""} ${runOutcome(result)}`,
		});
	}
	// `  ` between every column, and the list insets the row by two before it
	// prints the cursor and one more after it.
	const budget = sidebarWidth - 5;
	const numberWidth = widestOf(runRows, row => row.number);
	const metricWidth = widestOf(runRows, row => row.metric);
	const deltaWidth = widestOf(runRows, row => row.delta);
	const tagWidth = widestOf(runRows, row => row.tag);
	// The verdict outranks the change on the way down. The change is recoverable
	// by comparing two numbers in an aligned metric column; the column does not
	// identify which run the loop kept, which one it measures everything against,
	// or which one segfaulted. So the tag is charged first and the change takes
	// whatever is left.
	const withTag = numberWidth + metricWidth + tagWidth + 4;
	const showTag = tagWidth > 0 && withTag <= budget;
	const used = numberWidth + metricWidth + 2 + (showTag ? tagWidth + 2 : 0);
	const showDelta = deltaWidth > 0 && used + deltaWidth + 2 <= budget;
	for (const runRow of runRows) {
		let label = `${runRow.number.padEnd(numberWidth)}  ${runRow.metric.padEnd(metricWidth)}`;
		if (showDelta) label += `  ${runRow.delta.padStart(deltaWidth)}`;
		if (showTag) label += `  ${runRow.tag}`;
		rows.push({
			value: runRow.value,
			label: label.trimEnd(),
			group: `segment ${runRow.segment + 1}`,
			filterText: runRow.filterText,
		});
	}
	return rows;
}

function widestOf(rows: readonly RunRow[], pick: (row: RunRow) => string): number {
	let widest = 0;
	for (const row of rows) widest = Math.max(widest, pick(row).length);
	return widest;
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

/**
 * The session, read by someone asking whether the loop is getting anywhere.
 *
 * That question has one answer -- the best measurement so far, against the one
 * it started from -- and it is the first row, because a reader who reads
 * nothing else has read the thing they came for. The goal, the scope and the
 * branch are what the answer is about and follow it.
 */
function sessionDetail(runtime: AutoresearchRuntime, width: number): string[] {
	const state = runtime.state;
	const current = currentResults(state.results, state.currentSegment);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRun = findBaselineRunNumber(state.results, state.currentSegment);
	const best = findBestKeptResult(state.results, state.currentSegment, state.bestDirection);
	const lines: string[] = [];
	const direction = state.bestDirection === "lower" ? "lower" : "higher";
	if (best && baseline !== null) {
		const change = formatPercentChange(best.metric, baseline);
		const arm = best.arm ? ` · arm ${best.arm}` : "";
		lines.push(
			...field(
				"Best",
				`${formatNum(best.metric, state.metricUnit)}${change ? ` · ${change}` : ""}` +
					theme.fg("dim", ` · from ${formatNum(baseline, state.metricUnit)}`) +
					theme.fg("dim", ` · run ${best.runNumber ?? "?"}${arm}`),
				width,
			),
		);
	} else if (baseline !== null) {
		lines.push(
			...field(
				"Best",
				theme.fg("dim", "nothing has beaten the baseline yet") +
					` · ${formatNum(baseline, state.metricUnit)}${baselineRun ? theme.fg("dim", ` · run ${baselineRun}`) : ""}`,
				width,
			),
		);
	} else {
		lines.push(...field("Best", theme.fg("dim", "no baseline measured yet"), width));
	}
	// Whether the loop is still finding anything. "Best" is a point, and a point
	// cannot answer the question a reader has in front of a loop that has been
	// running for an hour: leave it, or stop it. Best at run 3 with eleven logged
	// is eight runs of nothing, which is the answer.
	// A run number is optional. An unnumbered run cannot be ordered against the
	// best, so it is not counted, and a best without one leaves the row off.
	const bestRun = best?.runNumber ?? null;
	if (bestRun !== null) {
		const since = current.filter(result => result.runNumber !== null && result.runNumber > bestRun).length;
		if (since > 0) {
			lines.push(...field("Since", `${since} ${since === 1 ? "run" : "runs"} later, none better`, width));
		}
	}
	// A row of eighth-blocks, one per run of the segment, oldest on the left.
	//
	// "Best" and "Since" are two numbers, and two numbers cannot show the shape
	// of the search: a loop that improved once and then flattened reads
	// identically to one still descending a step per run. The series shows both,
	// in a column per run and with no scrolling.
	const trend = metricTrend(current, best, width - LABEL_WIDTH);
	if (trend !== null) lines.push(...field("Trend", trend, width));
	lines.push(...field("Metric", `${state.metricName} · ${theme.fg("dim", `${direction} is better`)}`, width));
	if (state.confidence !== null) {
		lines.push(
			...field(
				"Confidence",
				`${state.confidence.toFixed(1)}x${theme.fg("dim", " · the run-to-run spread of this segment")}`,
				width,
			),
		);
	}
	lines.push("");
	lines.push(...field("Goal", runtime.goal ?? state.goal ?? "(not stated)", width));
	// The title carries the name too, and the title is inset into a border segment
	// as wide as the sidebar, so a long name reads in full only here.
	if (state.name) lines.push(...field("Session", state.name, width));
	lines.push("");
	// Only the outcomes that happened. A run of five counts, four of them zero,
	// is a row that has to be parsed before it turns out to report nothing.
	lines.push(...field("Segment", segmentTally(state, current), width));
	if (state.results.length > current.length) {
		lines.push(...field("Archived", `${state.results.length - current.length} runs from earlier segments`, width));
	}
	lines.push("");
	const breadth = effectiveBreadth(runtime);
	if (breadth > 1) {
		lines.push(...field("Breadth", `${breadth} arms per iteration`, width));
		const flagged = state.results.filter(result => result.flagged).length;
		if (flagged > 0) {
			const runs = flagged === 1 ? "run" : "runs";
			lines.push(...field("Flagged", `${flagged} ${runs}, excluded from best and baseline`, width));
		}
	} else {
		lines.push(...field("Breadth", "1 · serial, no arms and no review", width));
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

/**
 * `2  ·  4 runs, 2 kept, 1 crashed, 1 failed its checks`.
 *
 * An unrecorded outcome is left out. Printing every status the union has, most
 * of them zero, made the row longest when it had least to report.
 */
function segmentTally(state: ExperimentState, current: readonly ExperimentResult[]): string {
	const parts = [`${current.length} ${current.length === 1 ? "run" : "runs"}`];
	const kept = countBy(current, "keep");
	const discarded = countBy(current, "discard");
	const crashed = countBy(current, "crash");
	const failed = countBy(current, "checks_failed");
	if (kept > 0) parts.push(`${kept} kept`);
	if (discarded > 0) parts.push(`${discarded} discarded`);
	if (crashed > 0) parts.push(`${crashed} crashed`);
	if (failed > 0) parts.push(`${failed} failed its checks`);
	return `${state.currentSegment + 1}  ·  ${parts.join(", ")}`;
}

/**
 * Eighth-blocks, low to high. A full eight levels rather than the six of the
 * effort gauge in `theme/symbols.ts`, which drops `▄` and `▇` so that six
 * discrete settings each land on a distinguishable height; here the levels are
 * quantized from a continuous measurement and every step is worth having.
 */
const TREND_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * The segment's measurements as one row of blocks, oldest run on the left, or
 * null when there is not enough measured to have a shape.
 *
 * Height is the raw metric, not its distance from the goal, so the picture does
 * not silently flip when a session runs `higher is better`: the Metric row
 * states the direction and this row states the values. Two runs are a pair of
 * numbers the Best row already covers, so the floor is three.
 *
 * A run the harness never measured is a gap rather than a zero-height bar,
 * which is the same defect as printing its logged zero as a measurement: a
 * segfault would draw as the best result of a session where lower is better.
 */
function metricTrend(current: readonly ExperimentResult[], best: ExperimentResult | null, room: number): string | null {
	if (room < 8) return null;
	// The tail, not the head: the question in front of a long segment is where it
	// is going, and the oldest runs are the ones already answered by Best. One
	// column is held back for the ellipsis, so an elided row is `room` wide and
	// not `room + 1` -- a bar row that overran its pane would wrap under the
	// label column and read as a second, shorter series.
	const budget = current.length > room ? room - 1 : room;
	const shown = current.length > budget ? current.slice(current.length - budget) : current;
	const values: Array<number | null> = shown.map(result =>
		result.status === "crash" ? result.measuredPrimary : result.metric,
	);
	const measured = values.filter((value): value is number => value !== null && value > 0);
	if (measured.length < 3) return null;
	const low = Math.min(...measured);
	const high = Math.max(...measured);
	const span = high - low;
	const bars = values.map((value, index) => {
		const result = shown[index];
		if (value === null || value <= 0) return theme.fg("dim", "·");
		// A flat segment is mid-height, not a row of floors: every run measured the
		// same number, which is a real and legible answer.
		const level = span === 0 ? 3 : Math.min(7, Math.floor(((value - low) / span) * 8));
		const paint: ThemeColor = result.flagged ? "warning" : result === best ? "success" : "muted";
		return theme.fg(paint, TREND_LEVELS[level]);
	});
	const elided = current.length > shown.length ? theme.fg("dim", "…") : "";
	return `${elided}${bars.join("")}`;
}

function countBy(results: readonly ExperimentResult[], status: ExperimentResult["status"]): number {
	return results.filter(result => result.status === status).length;
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
			// The run directory is under the profile, so the untouched string states the home
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

/**
 * One run, read when deciding whether it is the change to keep.
 *
 * The order is that decision: what the loop concluded, what it measured against
 * the run every other run in the segment is measured against, who stands behind
 * it, and only then what it changed. A field with nothing to report is
 * absent rather than present and empty -- `Reviewed by (nobody)` on a run that
 * crashed before anyone could review it is a row that costs a line and answers
 * nothing.
 */
function runDetail(result: ExperimentResult, state: ExperimentState, width: number): string[] {
	// The run's own segment, not the current one: an archived run was judged
	// against the baseline of the segment it ran in, and a percentage against a
	// later segment's baseline describes a comparison the loop never made.
	const baseline = findBaselineMetric(state.results, result.segment);
	const baselineSecondary = findBaselineSecondary(state.results, result.segment, state.secondaryMetrics);
	const isBaseline = findBaselineRunNumber(state.results, result.segment) === result.runNumber;
	const isBest = findBestKeptResult(state.results, result.segment, state.bestDirection) === result;
	// The comparison is against the number the row shows: a crash that measured
	// nothing has none, and reading its logged zero against a 205ms baseline
	// printed `0ms  -100.0%`, a claim about a run that never finished.
	const shown = result.status === "crash" ? result.measuredPrimary : result.metric;
	const change = shown === null ? undefined : formatPercentChange(shown, baseline);
	const lines: string[] = [];
	// The verdict and the reviewer on one row: kept, certified by c, is one fact,
	// and splitting it left the reviewer four rows below the word it qualifies,
	// with a metric block in between.
	const certified = result.certifiedBy ? theme.fg("dim", `  ·  certified by ${result.certifiedBy}`) : "";
	lines.push(
		...field(
			"Outcome",
			theme.fg(statusPaint(result.status, result.flagged), runOutcome(result)) +
				(result.flagged ? theme.fg("dim", ` (logged ${result.status})`) : "") +
				certified,
			width,
		),
	);
	// What the number is for. A run with no percentage beside it is either the
	// reference every percentage is against or a run that measured nothing, and
	// an unexplained blank reads as a third thing: a number nobody compared.
	// ` · `, not two spaces: `field` wraps its value through the ANSI wrapper,
	// which collapses a run of spaces, so an alignment gap written here arrives
	// as one space and the value reads as a sentence fragment.
	const role = isBaseline
		? theme.fg("dim", " · the baseline of this segment")
		: isBest
			? theme.fg("dim", " · best of this segment")
			: "";
	lines.push(
		...field(
			state.metricName,
			`${metricLabel(result, state.metricUnit)}${change ? ` · ${change}` : ""}${role}`,
			width,
		),
	);
	for (const metric of state.secondaryMetrics) {
		const value = result.metrics[metric.name];
		if (value === undefined) continue;
		const delta = formatPercentChange(value, baselineSecondary[metric.name]);
		lines.push(...field(metric.name, `${formatNum(value, metric.unit)}${delta ? ` · ${delta}` : ""}`, width));
	}
	if (result.confidence !== null) {
		lines.push(
			...field(
				"Confidence",
				`${result.confidence.toFixed(1)}x${theme.fg("dim", " · the run-to-run spread of this segment")}`,
				width,
			),
		);
	}
	// The arm is what the loop attributed the run to; the model is what built it.
	// Reading one against the models the arms were configured with is the only
	// way to tell a model comparison from a round that stayed on one model. A
	// serial run carries no arm and still records the model it was measured on.
	if (result.arm !== null || result.model !== null) {
		lines.push("");
		if (result.arm !== null) {
			const breadth = state.breadth > 1 ? theme.fg("dim", ` of ${state.breadth}`) : "";
			lines.push(...field("Arm", `${result.arm}${breadth}`, width));
		}
		if (result.model !== null) {
			lines.push(...field("Built on", theme.fg("muted", result.model), width));
		}
	}
	if (result.flagged) {
		lines.push("");
		lines.push(...field("Flagged", theme.fg("warning", result.flaggedReason ?? "no reason recorded"), width));
		lines.push(
			...field("", theme.fg("dim", "A flagged run is excluded from the baseline and the best metric."), width),
		);
	}
	if (result.scopeDeviations.length > 0) {
		lines.push("");
		lines.push(...field("Off limits", theme.fg("warning", result.scopeDeviations.join(", ")), width));
		lines.push(
			...field("Justified", result.justification ?? theme.fg("warning", "no justification recorded"), width),
		);
	}
	lines.push("");
	lines.push(...field("Change", result.description || "(no description)", width));
	if (result.modifiedPaths.length > 0) lines.push(...field("Files", result.modifiedPaths.join(", "), width));
	// Twelve characters, the length git itself prints and the length the session
	// row already shortens the baseline commit to. Forty was the widest thing on
	// the pane and nobody reads past the first eight.
	if (result.commit) lines.push(...field("Commit", result.commit.slice(0, 12), width));
	const asi = result.asi;
	if (asi && Object.keys(asi).length > 0) {
		const entries = Object.entries(asi).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
		lines.push(...field("ASI", entries.join("  "), width));
	}
	return lines;
}

/**
 * The widest hint the footer can print whole, or the last one when even that
 * overflows. `row` insets a column on each side of the border pair.
 */
export function footerHint(width: number): string {
	const room = Math.max(0, width - 4);
	return FOOTER_HINTS.find(hint => hint.length <= room) ?? FOOTER_HINTS[FOOTER_HINTS.length - 1];
}

/**
 * Columns a detail pane needs before it can print anything. A pane narrower than
 * this holds a label column and nothing else, and at 31 columns the split gave
 * it two: every line of the run under the cursor arrived as an ellipsis, and the
 * card spent a third of a narrow terminal drawing a border around them.
 */
const DETAIL_MIN = 24;

/** True when the card is too narrow to carry two panes beside each other. */
export function screenStacks(width: number): boolean {
	return splitBodyWidth(width, screenSidebarWidth(width)) < DETAIL_MIN;
}

/**
 * Body rows the list takes when the card is stacked; the detail pane takes the
 * rest. The list gets the larger half of an odd split, because it is what the
 * page keys move through and a one-row list cannot show a cursor in context.
 */
export function screenListRows(bodyRows: number): number {
	return clampLow(Math.ceil(bodyRows / 2), 1, bodyRows - 1);
}

/** Body rows of a stacked card: two dividers rather than one. */
function stackedBodyRows(rows: number): number {
	return Math.max(2, rows - 5);
}

/**
 * The whole card: `rows` lines exactly, so the host never has to guess how tall
 * the screen came out. Two panes side by side where the terminal can pay for
 * them, one above the other where it cannot.
 */
export function renderRunScreen(
	runtime: AutoresearchRuntime,
	width: number,
	rows: number,
	sidebar: readonly string[],
	detail: readonly string[],
	sidebarWidth: number,
): string[] {
	const out: string[] = [];
	if (screenStacks(width)) {
		const bodyRows = stackedBodyRows(rows);
		const listRows = screenListRows(bodyRows);
		out.push(topBorder(width, screenTitle(runtime)));
		for (let index = 0; index < listRows; index += 1) out.push(row(sidebar[index] ?? "", width));
		out.push(divider(width));
		for (let index = 0; index < bodyRows - listRows; index += 1) out.push(row(detail[index] ?? "", width));
	} else {
		const bodyRows = Math.max(3, rows - 4);
		out.push(topBorderSplit(width, screenTitle(runtime), sidebarWidth));
		for (let index = 0; index < bodyRows; index += 1) {
			out.push(splitRow(sidebar[index] ?? "", detail[index] ?? "", width, sidebarWidth));
		}
	}
	out.push(screenStacks(width) ? divider(width) : dividerSplit(width, sidebarWidth));
	out.push(row(theme.fg("dim", footerHint(width)), width));
	out.push(bottomBorder(width));
	// The chrome has a floor of its own — two borders and the insets between
	// them — so a terminal narrower than that still gets rows it can print.
	return out.map(line => truncateToWidth(line, width));
}

/**
 * Sidebar column width for a card of `width` columns.
 *
 * A third rather than 0.28, because the difference controls whether the ledger
 * has a verdict column: at 0.28 a 120-column terminal gave the sidebar 33 and
 * the tag was shed at every width a reader is likely to have, which is a column
 * that does not exist. A third reaches the cap at 120 and the detail pane still
 * has more than twice the sidebar there.
 *
 * Two panes cost seven columns of chrome, so a sidebar sized only by its own
 * bounds wrote a 29-column frame into a 10-column terminal and the border
 * wrapped. A terminal that cannot pay for the sidebar's floor and one body
 * column gives the sidebar whatever is left instead.
 */
export function screenSidebarWidth(width: number): number {
	const wanted = clampLow(Math.floor(width / 3), SIDEBAR_MIN, SIDEBAR_MAX);
	return clampLow(wanted, 0, width - 8);
}

/**
 * What the sidebar is showing, as one string. A screen open across a logged run
 * rebuilds its list only when this changes, so an idle repaint allocates one
 * string instead of a list.
 *
 * The label, not the description: a row's label is the whole of what this list
 * prints, and keying on a field the list never draws rebuilt the sidebar for
 * changes no reader could see -- and left a changed label, which they can, to
 * be noticed only if some description happened to move with it.
 */
function signatureOf(items: readonly SelectItem[]): string {
	return items.map(item => `${item.value}|${item.label}`).join("\n");
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
		const items = runScreenRows(this.#runtime, this.#sidebarWidth);
		// The width is part of the signature: a resize sheds or restores a column
		// of every run row, and a signature blind to it left the list rendering
		// the columns of the width before last.
		const signature = `${this.#sidebarWidth}\n${signatureOf(items)}`;
		if (signature === this.#signature) return;
		this.#signature = signature;
		this.#list.setItems(items);
	}

	render(width: number): readonly string[] {
		const rows = Math.max(SCREEN_MIN_ROWS, this.#rows());
		const sidebarWidth = screenSidebarWidth(width);
		this.#sidebarWidth = screenStacks(width) ? width - 4 : sidebarWidth;
		// After the width, because the rows are built against it.
		this.#sync();
		// Stacked, both panes are the full inner width and the rows are split
		// between them; side by side, both panes get every body row.
		const stackedRows = stackedBodyRows(rows);
		const listRows = screenStacks(width) ? screenListRows(stackedRows) : Math.max(3, rows - 4);
		const detailRows = screenStacks(width) ? stackedRows - listRows : Math.max(3, rows - 4);
		const paneWidth = screenStacks(width) ? width - 4 : splitBodyWidth(width, sidebarWidth);
		this.#list.setRowBudget(listRows);
		const sidebar = this.#list.render(this.#sidebarWidth);
		this.#detailRows = detailRows;
		const detail = this.#detailWindow(paneWidth, detailRows);
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
