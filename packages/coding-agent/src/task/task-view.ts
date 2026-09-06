/**
 * The task card as a view: the agents a call spawned, what each is doing, and how each finished.
 *
 * The card is a TREE rather than a list, and that is the whole reason this module states depth and
 * never a glyph: an agent that spawned agents of its own is structure, its own detail rows belong to
 * it however deep it sits, and the branch, the elbow and the vertical run that carries a parent past
 * its children are the terminal's answer to depth. A browser guest indents, a transcript export
 * writes nested list items, and none of them is handed a `├─`.
 *
 * WHAT THE CARD SHOWS. A call in flight shows one row per spawned agent, live or queued, with the
 * tool it is part way through, the recovery it is sleeping between attempts of, and its nested
 * agents under it. A settled call shows one row per result, with its outcome, its counts, what it
 * returned, and a review verdict when the agent was a reviewer. Both are the same rows: a batch that
 * finished half its work shows results and live progress in one tree.
 *
 * WHAT IT DOES NOT DO. It draws nothing. Every bound here is a bound on CONTENT — how many agents a
 * collapsed card names, how many lines of output it keeps, how long a preview runs — and every bound
 * on ROWS is the host's, which is why the live output window is a stated number of lines rather than
 * a fraction of a terminal it cannot see.
 */

import path from "node:path";
import { formatCount, formatNumber, isRecord, sanitizeText } from "@veyyon/utils";
import type {
	FramedBlockView,
	StatusRowView,
	ToolViewContext,
	ToolViewRenderer,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewStatus,
	ViewTone,
	ViewTreeLines,
} from "@veyyon/view";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../config/settings-instance";
import {
	type FindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	parseReportFindingDetails,
	type ReportFindingDetails,
	type SubmitReviewDetails,
} from "../tools/agent/review";
import { jsonTreeViewLines } from "../tools/core/json-tree-view";
import {
	formatDuration,
	formatMoreItems,
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	truncateToWidth,
} from "../tools/core/render-utils";
import { appendAgentStats, sanitizeRecentOutput, span } from "./agent-stats";
import { classifySubagentOutcome } from "./outcome";
import { repairDoubleEncodedJsonString, repairTaskParams } from "./repair-args";
import { DEFAULT_SPAWN_AGENT } from "./spawn-policy";
import { YIELD_TOOL_NAME } from "./subprocess-tool-registry";
import { formatTaskId } from "./task-id";
import type { AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails, YieldItem } from "./types";
import { assembleYieldResult } from "./yield-assembly";

/** What the tool returns, as the card reads it. */
export interface TaskViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: TaskToolDetails;
	isError?: boolean;
}

/** How deep the card follows a tree of spawned agents before it says so and stops. */
const MAX_NESTED_TASK_RENDER_DEPTH = 8;

/** Agent rows a collapsed card keeps; the rest close with a count. */
const COLLAPSED_AGENT_LIMIT = 4;

/**
 * Output rows a live agent shows while the card is expanded.
 *
 * A number rather than a fraction of the reader's viewport: the tool cannot see one, and it would
 * have to read the terminal's height to derive it. Six is what a card on an ordinary terminal kept,
 * and it is a bound on how much of a noisy agent's stream is worth showing rather than a bound on
 * rows, which stays the host's. A card with three live agents therefore spends the same on each
 * however tall the window is, where the row budget alone would have given a short window less.
 */
const LIVE_OUTPUT_ROWS = 6;

/** Where a node sits in the tree the card draws. */
interface NodePlace {
	depth: number;
	last: boolean;
}

/** One line of the card's body, and the node it belongs to. */
interface TaskRow {
	spans: ViewSpan[];
	depth: number;
	opens: boolean;
	last: boolean;
}

const TOP: NodePlace = { depth: 0, last: true };

function openRow(place: NodePlace, spans: ViewSpan[]): TaskRow {
	return { spans, depth: place.depth, last: place.last, opens: true };
}

function detailRow(place: NodePlace, spans: ViewSpan[]): TaskRow {
	return { spans, depth: place.depth, last: place.last, opens: false };
}

/**
 * The separator between two trailing facts of a row, as the host's own glyph.
 *
 * A row that stated a literal dot would draw one on a terminal whose preset writes ` - `, so the mark
 * is named and the fallback text is what a host with no glyph for it writes.
 */
const DOT: ViewSpan = { text: " · ", symbol: "sep.dot", tone: "dim" };

/** The two columns a section's own body sits in, under the line that names it. */
const INSET: ViewSpan = { text: "  " };

/** The tone a finding's priority carries, which the review module decides and this reads back. */
const PRIORITY_TONES: Readonly<Record<string, ViewTone>> = {
	error: "error",
	warning: "warning",
	muted: "muted",
	accent: "accent",
	info: "info",
	success: "success",
};

function priorityTone(priority: FindingPriority): ViewTone {
	return PRIORITY_TONES[getPriorityInfo(priority).color] ?? "muted";
}

/** The mark an agent's state carries, which the host animates when the state is one that moves. */
function statusOf(status: AgentProgress["status"]): ViewStatus {
	switch (status) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "aborted":
			return "aborted";
	}
}

/** One count per priority, and the words for a review that found nothing. */
function findingSummarySpans(findings: ReportFindingDetails[]): ViewSpan[] {
	if (findings.length === 0) return [span("Findings: none", "dim")];

	const counts: { [P in FindingPriority]?: number } = {};
	for (const finding of findings) counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;

	const line: ViewSpan[] = [span("Findings:", "dim"), span(" ")];
	PRIORITY_LABELS.forEach((label, index) => {
		if (index > 0) line.push(DOT);
		const tone = priorityTone(label);
		line.push(
			{ text: "", symbol: getPriorityInfo(label).symbol, tone },
			span(" "),
			span(`${label}:${counts[label] ?? 0}`, tone),
		);
	});
	return line;
}

function normalizeReportFindings(value: unknown): ReportFindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: ReportFindingDetails[] = [];
	for (const item of value) {
		const finding = parseReportFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

/** Reviewer output declares `findings` as an array, so a lone finding section still assembles as a list. */
const REVIEWER_ARRAY_LABELS: ReadonlySet<string> = new Set(["findings"]);

function extractIncrementalReviewResult(
	items: RenderYieldItem[],
): { summary: SubmitReviewDetails; findings: ReportFindingDetails[] } | undefined {
	const yieldItems: YieldItem[] = items.map(item => ({
		data: item.data,
		type: item.type,
		status: item.status === "aborted" ? "aborted" : item.status === "success" ? "success" : undefined,
		useLastTurn: item.useLastTurn,
	}));
	const assembled = assembleYieldResult(yieldItems, undefined, REVIEWER_ARRAY_LABELS);
	const data = assembled?.data;
	if (!isRecord(data)) return undefined;
	const record = data as Record<string, unknown>;
	const overallCorrectness = record.overall_correctness;
	const explanation = record.explanation;
	const confidence = record.confidence;
	if (
		(overallCorrectness !== "correct" && overallCorrectness !== "incorrect") ||
		typeof explanation !== "string" ||
		typeof confidence !== "number"
	) {
		return undefined;
	}
	return {
		summary: { overall_correctness: overallCorrectness, explanation, confidence },
		findings: normalizeReportFindings(record.findings),
	};
}

interface RenderYieldItem {
	data?: unknown;
	type?: string | string[];
	status?: string;
	useLastTurn?: boolean;
}

/**
 * The `yield` slot of `extractedToolData` as a list of yield records.
 *
 * The executor always fills the slot with an array, and a stray single object still has to survive:
 * optional chaining short-circuits on `null` and `undefined` alone, so `.map` on a plain object
 * threw and took the card with it. A lone object is read as a one-entry list and a primitive drops.
 */
function normalizeYieldData(value: unknown): RenderYieldItem[] {
	const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const normalized: RenderYieldItem[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const typeValue = record.type;
		let type: RenderYieldItem["type"];
		if (typeof typeValue === "string") {
			type = typeValue;
		} else if (Array.isArray(typeValue)) {
			const labels: string[] = [];
			let allLabels = true;
			for (const label of typeValue) {
				if (typeof label !== "string") {
					allLabels = false;
					break;
				}
				labels.push(label);
			}
			if (allLabels) type = labels;
		}
		normalized.push({
			data: record.data,
			type,
			status: typeof record.status === "string" ? record.status : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
		});
	}
	return normalized;
}

function getRenderYieldLabels(type: RenderYieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

function formatYieldPreview(item: RenderYieldItem): string {
	if (item.useLastTurn === true && item.data === undefined) return "last assistant turn";
	if (item.data === undefined) return "last assistant turn";
	if (typeof item.data === "string") return previewLine(replaceTabs(sanitizeText(item.data)), YIELD_PREVIEW_WIDTH);
	try {
		return previewLine(replaceTabs(sanitizeText(JSON.stringify(item.data) ?? "null")), YIELD_PREVIEW_WIDTH);
	} catch {
		return previewLine(replaceTabs(sanitizeText(String(item.data))), YIELD_PREVIEW_WIDTH);
	}
}

/** Columns one yielded section's preview may spend. */
const YIELD_PREVIEW_WIDTH = 70;

/** Yield sections a collapsed card names, newest last. */
const COLLAPSED_YIELD_LIMIT = 3;

function yieldSectionRows(value: unknown, place: NodePlace, expanded: boolean): TaskRow[] {
	const typedItems: Array<{ item: RenderYieldItem; labels: string[] }> = [];
	for (const item of normalizeYieldData(value)) {
		const labels = getRenderYieldLabels(item.type);
		if (labels.length === 0) continue;
		typedItems.push({ item, labels });
	}
	const displayCount = expanded ? typedItems.length : COLLAPSED_YIELD_LIMIT;
	const rows: TaskRow[] = [];
	for (const { item, labels } of typedItems.slice(-displayCount)) {
		const terminal = !Array.isArray(item.type);
		const label = `${terminal ? "yield" : "yield+"}[${labels.join(", ")}]`;
		rows.push(detailRow(place, [span(label, "dim"), span(": "), span(formatYieldPreview(item), "dim")]));
	}
	if (typedItems.length > displayCount) {
		rows.push(detailRow(place, [span(formatMoreItems(typedItems.length - displayCount, "yield"), "dim")]));
	}
	return rows;
}
/** Columns one line of an agent's output may spend before it is cut. */
const OUTPUT_LINE_WIDTH = 70;

/** Columns a warning above an agent's output may spend. */
const OUTPUT_WARNING_WIDTH = 80;

/**
 * What an agent returned: a JSON value as a tree, or its output as lines.
 *
 * The warning an agent that never called `yield` carries opens the section, because it is the reason
 * the output below it is whatever the process happened to print.
 */
function outputRows(
	output: string,
	place: NodePlace,
	expanded: boolean,
	maxCollapsed = 3,
	maxExpanded = 10,
	warning?: string,
): TaskRow[] {
	const rows: TaskRow[] = [];
	const trimmedOutput = sanitizeText(output).trimEnd();
	if (!trimmedOutput && !warning) return rows;

	const inset = warning ? [INSET] : [];
	if (warning) {
		rows.push(detailRow(place, [span("Output", "dim")]));
		rows.push(
			detailRow(place, [
				INSET,
				{ text: "", symbol: "status.warning", tone: "warning" },
				span(" "),
				span(truncateToWidth(sanitizeText(warning), OUTPUT_WARNING_WIDTH), "dim"),
			]),
		);
		if (!trimmedOutput) return rows;
	}

	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmedOutput);
			// Collapsed: the same one-line summary the arguments of a call get.
			if (!expanded) {
				rows.push(detailRow(place, [...inset, span(formatOutputInline(parsed), "dim")]));
				return rows;
			}
			if (!warning) rows.push(detailRow(place, [span("Output", "dim")]));
			const tree = jsonTreeViewLines(parsed, {
				maxDepth: JSON_TREE_DEPTH,
				maxLines: JSON_TREE_LINES,
				maxScalarLen: OUTPUT_LINE_WIDTH,
			});
			if (tree.lines.length > 0) {
				for (const line of tree.lines) rows.push(detailRow(place, [INSET, ...line]));
				if (tree.truncated) rows.push(detailRow(place, [INSET, span("…", "dim")]));
				return rows;
			}
		} catch {
			// Not JSON after all: fall through to the raw output below.
		}
	}

	if (!warning) rows.push(detailRow(place, [span("Output", "dim")]));

	const outputLines = trimmedOutput.split("\n");
	const previewCount = expanded ? maxExpanded : maxCollapsed;
	for (const line of outputLines.slice(0, previewCount)) {
		rows.push(detailRow(place, [INSET, span(truncateToWidth(replaceTabs(line), OUTPUT_LINE_WIDTH), "dim")]));
	}
	if (outputLines.length > previewCount) {
		rows.push(detailRow(place, [INSET, span(formatMoreItems(outputLines.length - previewCount, "line"), "dim")]));
	}
	return rows;
}

/** Levels of a returned JSON value an expanded card walks, and the lines it may spend on them. */
const JSON_TREE_DEPTH = 6;
const JSON_TREE_LINES = 24;

/** Lines of an agent's brief an expanded card shows. */
const ASSIGNMENT_ROWS = 20;

/** The brief an agent was given, which an expanded card shows under its row. */
function assignmentRows(task: string, place: NodePlace, expanded: boolean): TaskRow[] {
	const rows: TaskRow[] = [];
	const trimmed = sanitizeText(task).trim();
	if (!expanded || !trimmed) return rows;

	rows.push(detailRow(place, [span("Task", "dim")]));
	const taskLines = trimmed.split("\n");
	for (const line of taskLines.slice(0, ASSIGNMENT_ROWS)) {
		rows.push(detailRow(place, [INSET, span(truncateToWidth(replaceTabs(line), OUTPUT_LINE_WIDTH), "dim")]));
	}
	if (taskLines.length > ASSIGNMENT_ROWS) {
		rows.push(detailRow(place, [INSET, span(formatMoreItems(taskLines.length - ASSIGNMENT_ROWS, "line"), "dim")]));
	}
	return rows;
}

function formatScalarInline(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const sanitizedValue = sanitizeText(value);
		const firstLine = sanitizedValue.split("\n")[0].trim();
		if (firstLine.length === 0) return `"" (${sanitizedValue.split("\n").length} lines)`;
		const preview = truncateToWidth(firstLine, maxLen);
		if (sanitizedValue.includes("\n")) return `"${preview}…" (${sanitizedValue.split("\n").length} lines)`;
		return `"${preview}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
	return sanitizeText(String(value));
}

function formatOutputInline(data: unknown, maxWidth = 80): string {
	if (data === null || data === undefined) return "Output: none";
	if (typeof data !== "object") return `Output: ${formatScalarInline(data, 60)}`;
	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		const preview = formatScalarInline(data[0], 40);
		return `Output: [${data.length} items] ${preview}${data.length > 1 ? "…" : ""}`;
	}

	const entries = Object.entries(data as Record<string, unknown>);
	if (entries.length === 0) return "Output: {}";

	const pairs: string[] = [];
	let totalLen = "Output: ".length;
	for (const [key, value] of entries) {
		const pairStr = `${sanitizeText(key)}=${formatScalarInline(value, 24)}`;
		const addLen = pairs.length > 0 ? pairStr.length + 2 : pairStr.length;
		if (totalLen + addLen > maxWidth && pairs.length > 0) {
			pairs.push("…");
			break;
		}
		pairs.push(pairStr);
		totalLen += addLen;
	}
	return `Output: ${pairs.join(", ")}`;
}

/**
 * First line of a streamed brief, trimmed — a row's secondary text.
 * The arguments arrive token by token, so a value that is not yet a string reads as nothing.
 */
function taskFirstLine(task: unknown): string {
	if (typeof task !== "string") return "";
	const trimmed = sanitizeText(task).trim();
	const newline = trimmed.indexOf("\n");
	return newline === -1 ? trimmed : trimmed.slice(0, newline);
}

/**
 * The header's description while nothing has spawned yet: the flat form's agent type.
 *
 * A batch states none, because every row carries its own agent badge and a joined list of the same
 * types above them repeats each one.
 */
function agentHeaderLabel(args: Partial<TaskParams> | undefined): string | undefined {
	if (!args) return undefined;
	const flat = typeof args.agent === "string" ? args.agent.trim() : "";
	return flat || undefined;
}

/** The agent type a row names, when it is not the generic worker. */
function agentTypeBadge(agent: string | undefined): ViewSpan[] {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === DEFAULT_SPAWN_AGENT) return [];
	return [span(" "), { text: trimmed, badge: true, tone: "dim" }];
}

/** Columns an agent's brief may spend on the row that names it. */
const BRIEF_WIDTH = 64;

/** The agent a call is spawning, while its arguments are still arriving. */
function callRows(args: Partial<TaskParams> | undefined): TaskRow[] {
	if (!args) return [];
	const rows: TaskRow[] = [];
	const rawName = typeof args.name === "string" ? args.name.trim() : "";
	const idLabel = rawName ? formatTaskId(rawName) : "";
	const brief = taskFirstLine(args.task);
	if (idLabel || brief) {
		const line: ViewSpan[] = [span("•", "dim"), span(" "), { text: idLabel || "agent", tone: "accent", bold: true }];
		if (brief) line.push(span(": "), span(previewLine(brief, BRIEF_WIDTH), "muted"));
		line.push(...agentTypeBadge(args.agent));
		rows.push(openRow(TOP, line));
	}
	rows.push(...callItemRows(args.tasks));
	return rows;
}

/**
 * The per-agent list of a batch call, while its arguments are still arriving.
 *
 * The array grows over time and its last entry may be half parsed, so every field is read
 * defensively and an entry with no name yet is numbered by its position.
 */
function callItemRows(tasks: TaskItem[] | undefined): TaskRow[] {
	if (!Array.isArray(tasks) || tasks.length === 0) return [];
	const cap = Math.min(tasks.length, COLLAPSED_AGENT_LIMIT);
	const rows: TaskRow[] = [];
	for (let i = 0; i < cap; i++) {
		const item = tasks[i] as Partial<TaskItem> | undefined;
		const rawName = typeof item?.name === "string" ? item.name.trim() : "";
		const idLabel = rawName ? formatTaskId(rawName) : `#${i + 1}`;
		const line: ViewSpan[] = [span("•", "dim"), span(" "), { text: idLabel, tone: "accent", bold: true }];
		const brief = taskFirstLine(item?.task);
		if (brief) line.push(span(": "), span(previewLine(brief, BRIEF_WIDTH), "muted"));
		line.push(...agentTypeBadge(item?.agent));
		if (item?.isolated === true) line.push(span(" [isolated]", "dim"));
		rows.push(openRow(TOP, line));
	}
	if (cap < tasks.length) {
		rows.push(openRow(TOP, [span("•", "dim"), span(" "), span(formatMoreItems(tasks.length - cap, "agent"), "dim")]));
	}
	return rows;
}

/** The brief and the shared background, as the documents they were written as. */
function markdownSection(text: string | undefined, separator: boolean): ViewSection | undefined {
	// A result carries the raw arguments, so per-field double encoding is undone here as well as on
	// the call path. The repair is idempotent on text that is already clean.
	const source = sanitizeText(repairDoubleEncodedJsonString(typeof text === "string" ? text : "")).trim();
	if (!source) return undefined;
	return {
		lines: source.split("\n").map(line => [span(line, "muted")]),
		markdown: true,
		...(separator ? { separator: true } : {}),
	};
}

/** Columns the tool an agent is running may spend. */
const TOOL_DETAIL_WIDTH = 40;

/** How long a tool has to run before the row says how long. */
const SLOW_TOOL_MS = 5000;

/**
 * One live or queued agent: what it is, what it is doing, and what it has spent.
 *
 * A live or queued agent keeps the same mark a finished one has rather than a spinner: an async
 * spawn stays queued while real work runs, so a moving glyph reads as a call the turn is waiting on.
 */
function progressRows(
	progress: AgentProgress,
	place: NodePlace,
	expanded: boolean,
	frozen: boolean,
	seen: WeakSet<object> | undefined,
	nestedDepth: number,
): TaskRow[] {
	const rows: TaskRow[] = [];
	const iconTone: ViewTone =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

	const trimmedDescription = progress.description?.trim();
	const description = trimmedDescription ? previewLine(sanitizeText(trimmedDescription), BRIEF_WIDTH) : undefined;
	const displayId = formatTaskId(progress.id);
	const line: ViewSpan[] = [];
	if (progress.status === "running" || progress.status === "pending") {
		const tone: ViewTone = frozen ? "dim" : "accent";
		line.push({ text: "", symbol: "status.done", tone }, span(" "));
		line.push(description === undefined ? span(displayId, tone) : { text: displayId, tone, bold: true });
		if (description) line.push(span(":", tone), span(" "), span(description, tone));
	} else if (progress.status === "completed") {
		// A finished row settles from the accent to the card's own body text: completion reads as a
		// colour change rather than as a new mark, mark included.
		line.push({ text: "", symbol: "status.done", tone: "text" }, span(" "));
		if (description) line.push({ text: displayId, tone: "text", bold: true }, span(`: ${description}`, "text"));
		else line.push(span(displayId, "text"));
	} else {
		line.push({ text: "", status: statusOf(progress.status), tone: iconTone }, span(" "));
		if (description) line.push({ text: displayId, tone: "accent", bold: true }, span(`: ${description}`, "accent"));
		else line.push(span(displayId, "accent"));
	}
	line.push(...agentTypeBadge(progress.agent));

	// A recovery badge says the child is sleeping between attempts rather than progressing. It wins
	// over the plain running mark, because waiting is the operationally meaningful state.
	if (progress.retryState && progress.status === "running") {
		line.push(span(" "), {
			text: progress.retryState.mode === "continue" ? "continuing" : "retrying",
			badge: true,
			tone: "warning",
		});
	} else if (progress.retryFailure && (progress.status === "failed" || progress.status === "aborted")) {
		// The badge names the recovery that gave up and never a cause: `retryFailure` is set from any
		// unsuccessful recovery, and the row under it already says which one.
		line.push(span(" "), {
			text: progress.retryFailure.mode === "continue" ? "continuation gave up" : "retries gave up",
			badge: true,
			tone: "error",
		});
	} else if (progress.status === "failed" || progress.status === "aborted") {
		line.push(span(" "), { text: progress.status === "failed" ? "failed" : "aborted", badge: true, tone: iconTone });
	}

	const showBadge = settings.get("subagent.showResolvedModelBadge");
	if (progress.status === "running") {
		if (!description) {
			line.push(
				span(" "),
				span(previewLine(sanitizeText(progress.assignment ?? progress.task), TOOL_DETAIL_WIDTH), "muted"),
			);
		}
		appendAgentStats(line, { ...progress, showResolvedModelBadge: showBadge });
	} else if (progress.status === "completed") {
		appendAgentStats(line, { ...progress, showResolvedModelBadge: showBadge });
	}

	rows.push(openRow(place, line));
	rows.push(...assignmentRows(progress.assignment ?? progress.task, place, expanded));

	if (progress.status === "running") {
		if (progress.currentTool) {
			const toolLine: ViewSpan[] = [
				{ text: "", symbol: "tree.hook", tone: "dim" },
				span(" "),
				span(sanitizeText(progress.currentTool), "muted"),
			];
			const toolDetail = progress.lastIntent ?? progress.currentToolArgs;
			if (toolDetail)
				toolLine.push(span(": "), span(previewLine(sanitizeText(toolDetail), TOOL_DETAIL_WIDTH), "dim"));
			if (progress.currentToolStartMs) {
				const elapsed = Date.now() - progress.currentToolStartMs;
				if (elapsed > SLOW_TOOL_MS) toolLine.push(DOT, span(formatDuration(elapsed), "warning"));
			}
			rows.push(detailRow(place, toolLine));
		} else if (progress.recentTools.length > 0) {
			// Idle between tools: the row names the last one that finished.
			const recent = progress.recentTools[0];
			const toolLine: ViewSpan[] = [
				{ text: "", symbol: "tree.hook", tone: "dim" },
				span(" "),
				span(sanitizeText(recent.tool), "dim"),
			];
			const toolDetail = progress.lastIntent ?? recent.args;
			if (toolDetail)
				toolLine.push(span(": "), span(previewLine(sanitizeText(toolDetail), TOOL_DETAIL_WIDTH), "dim"));
			rows.push(detailRow(place, toolLine));
		}
	}

	// Why the agent is paused and roughly how long until the next attempt. Without it the card spins
	// while a child sleeps out a three-hour provider rate limit.
	if (progress.retryState && progress.status === "running") {
		const remainingMs = Math.max(0, progress.retryState.startedAtMs + progress.retryState.delayMs - Date.now());
		const waitLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "now";
		// A continuation is not a retry: the batch cannot be resent, so the child carries the turn
		// forward instead, and saying "retrying" named the one thing that did not happen.
		const verb = progress.retryState.mode === "continue" ? "continuing" : "retrying";
		const summary = `${verb} ${progress.retryState.attempt}/${progress.retryState.maxAttempts} ${waitLabel}: ${previewLine(
			sanitizeText(progress.retryState.errorMessage),
			RETRY_MESSAGE_WIDTH,
		)}`;
		rows.push(
			detailRow(place, [{ text: "", symbol: "tree.hook", tone: "dim" }, span(" "), span(summary, "warning")]),
		);
	} else if (progress.retryFailure && progress.status !== "running") {
		const gaveUp = progress.retryFailure.mode === "continue" ? "continuation" : "auto-retry";
		const summary = `${gaveUp} gave up after ${formatCount("attempt", progress.retryFailure.attempt)}: ${previewLine(
			sanitizeText(progress.retryFailure.errorMessage),
			OUTPUT_WARNING_WIDTH,
		)}`;
		rows.push(detailRow(place, [{ text: "", symbol: "tree.hook", tone: "dim" }, span(" "), span(summary, "error")]));
	}

	if (progress.extractedToolData) {
		// A finished reviewer states its verdict from the yield sections it assembled, falling back to
		// the older `report_finding` side channel.
		if (progress.status === "completed") {
			const completeData = normalizeYieldData(progress.extractedToolData.yield);
			const incrementalReview = extractIncrementalReviewResult(completeData);
			if (incrementalReview) {
				rows.push(...reviewRows(incrementalReview.summary, incrementalReview.findings, place, expanded));
				return rows;
			}
			const reviewData = completeData
				.map(c => c.data as SubmitReviewDetails)
				.filter(d => d && typeof d === "object" && "overall_correctness" in d);
			if (reviewData.length > 0) {
				const summary = reviewData[reviewData.length - 1];
				rows.push(
					...reviewRows(
						summary,
						normalizeReportFindings(progress.extractedToolData.report_finding),
						place,
						expanded,
					),
				);
				return rows;
			}
		}

		for (const toolName in progress.extractedToolData) {
			const dataArray = progress.extractedToolData[toolName];
			if (toolName === YIELD_TOOL_NAME) {
				rows.push(...yieldSectionRows(dataArray, place, expanded));
				continue;
			}
			if (toolName === "report_finding") {
				const findings = normalizeReportFindings(dataArray);
				if (findings.length === 0) continue;
				rows.push(detailRow(place, findingSummarySpans(findings)));
				rows.push(...findingRows(findings, place, expanded));
			}
			// Nested task data has its own tree below, which also merges in the in-flight snapshot.
		}
	}

	// The nested tree: sub-calls this agent finished plus the one it is inside, so deep progress
	// reaches the reader without waiting for this agent's own turn to end.
	const completedTaskCalls = (progress.extractedToolData?.task as TaskToolDetails[] | undefined) ?? [];
	const inflight = progress.inflightTaskDetails;
	if (completedTaskCalls.length > 0 || inflight) {
		const snapshots = inflight ? [...completedTaskCalls, inflight] : completedTaskCalls;
		rows.push(...nestedTreeRows(snapshots, place.depth + 1, expanded, frozen, seen, nestedDepth));
	}

	if (expanded && progress.status === "running") {
		const output = liveOutput(progress.recentOutput);
		rows.push(...outputRows(output, place, expanded, 2, LIVE_OUTPUT_ROWS));
	}

	return rows;
}

/** Columns a retry's own error message may spend. */
const RETRY_MESSAGE_WIDTH = 60;

/**
 * The newest rows of a live agent's output, oldest of them replaced by a count.
 *
 * The rows arrive newest first, so they are reversed into reading order and the front is what a
 * window drops.
 */
function liveOutput(recentOutput: readonly string[]): string {
	const rows = sanitizeRecentOutput([...recentOutput].reverse().join("\n")).split("\n");
	if (rows.length <= LIVE_OUTPUT_ROWS) return rows.join("\n");
	const visible = LIVE_OUTPUT_ROWS <= 1 ? [] : rows.slice(rows.length - (LIVE_OUTPUT_ROWS - 1));
	const hidden = rows.length - visible.length;
	return [`… ${hidden} earlier ${hidden === 1 ? "line" : "lines"}`, ...visible].join("\n");
}

/** A reviewer's verdict, its explanation and the findings it filed. */
function reviewRows(
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	place: NodePlace,
	expanded: boolean,
): TaskRow[] {
	const rows: TaskRow[] = [];
	const correct = summary.overall_correctness === "correct";
	const verdictTone: ViewTone = correct ? "success" : "error";
	rows.push(
		detailRow(place, [
			span(" Patch is "),
			span(summary.overall_correctness, verdictTone),
			span(" "),
			correct
				? { text: "", symbol: "status.done", tone: "accent" }
				: { text: "", symbol: "status.error", tone: verdictTone },
			span(" "),
			span(`(${(summary.confidence * 100).toFixed(0)}% confidence)`, "dim"),
		]),
	);

	if (summary.explanation) {
		if (expanded) {
			rows.push(detailRow(place, [span("Summary", "dim")]));
			for (const line of sanitizeText(summary.explanation).split("\n")) {
				rows.push(detailRow(place, [INSET, span(replaceTabs(line), "dim")]));
			}
		} else {
			// The first sentence, or as much of one as fits.
			const flat = replaceTabs(sanitizeText(summary.explanation)).replace(/[\r\n]+/g, " ");
			const firstSentence = flat.split(/[.!?]/)[0].trim();
			rows.push(detailRow(place, [span(truncateToWidth(`${firstSentence}.`, EXPLANATION_WIDTH), "dim")]));
		}
	}

	rows.push(detailRow(place, findingSummarySpans(findings)));
	if (findings.length > 0) rows.push(...findingRows(findings, place, expanded));
	return rows;
}

/** Columns a collapsed review explanation may spend. */
const EXPLANATION_WIDTH = 100;

/** Findings a collapsed card names, most severe first. */
const COLLAPSED_FINDING_LIMIT = 3;

/** One node per finding, under the agent that filed it. */
function findingRows(findings: ReportFindingDetails[], place: NodePlace, expanded: boolean): TaskRow[] {
	const rows: TaskRow[] = [];
	const sorted = expanded
		? findings
		: [...findings].sort((a, b) => getPriorityInfo(a.priority).ord - getPriorityInfo(b.priority).ord);
	const displayCount = expanded ? sorted.length : Math.min(COLLAPSED_FINDING_LIMIT, sorted.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = sorted[i];
		const isLast = i === displayCount - 1 && (expanded || sorted.length <= COLLAPSED_FINDING_LIMIT);
		const at: NodePlace = { depth: place.depth + 1, last: isLast };
		const title = replaceTabs(sanitizeText(finding.title?.replace(/^\[P\d\]\s*/, "") ?? "Untitled")).replace(
			/[\r\n]+/g,
			" ",
		);
		const loc = `${path.basename(sanitizeText(finding.file_path || "<unknown>"))}:${finding.line_start}`;
		rows.push(
			openRow(at, [
				span(`[${finding.priority}]`, priorityTone(finding.priority)),
				span(` ${title} `),
				span(loc, "dim"),
			]),
		);
		if (expanded && finding.body) {
			for (const bodyLine of sanitizeText(finding.body).split("\n")) {
				rows.push(detailRow(at, [span(replaceTabs(bodyLine), "dim")]));
			}
		}
	}

	if (!expanded && findings.length > COLLAPSED_FINDING_LIMIT) {
		rows.push(detailRow(place, [span(formatMoreItems(findings.length - COLLAPSED_FINDING_LIMIT, "finding"), "dim")]));
	}
	return rows;
}

/** One finished agent: how it ended, what it spent, and what it returned. */
function resultRows(
	result: SingleResult,
	place: NodePlace,
	expanded: boolean,
	seen: WeakSet<object> | undefined,
	nestedDepth: number,
): TaskRow[] {
	const rows: TaskRow[] = [];
	const { warning: missingYieldWarning, rest: outputWithoutWarning } = extractMissingYieldWarning(result.output);
	// The same classification the wire uses, so a row cannot read as done while the tool result is
	// marked an error, or the reverse.
	const outcome = classifySubagentOutcome(result);
	const aborted = outcome.kind === "aborted";
	const mergeFailed = outcome.kind === "merge-failed";
	const success = outcome.kind === "completed";
	const needsWarning = Boolean(missingYieldWarning) && success;
	const tone: ViewTone = needsWarning ? "warning" : success ? "success" : mergeFailed ? "warning" : "error";
	const statusText = aborted
		? "aborted"
		: needsWarning
			? "warning"
			: success
				? "done"
				: mergeFailed
					? "merge failed"
					: "failed";

	const trimmedDescription = result.description ? sanitizeText(result.description).trim() : undefined;
	const description = trimmedDescription ? previewLine(trimmedDescription, BRIEF_WIDTH) : undefined;
	const displayId = formatTaskId(result.id);
	const settled = success && !needsWarning;
	const titleTone: ViewTone = settled ? "text" : "accent";
	const line: ViewSpan[] = [
		aborted
			? { text: "", status: "aborted", tone }
			: needsWarning
				? { text: "", symbol: "status.warning", tone }
				: success
					? // Settled: the mark takes the card's body text, like the row it opens.
						{ text: "", symbol: "status.done", tone: "text" }
					: { text: "", symbol: "status.error", tone },
		span(" "),
	];
	if (description) {
		line.push({ text: displayId, tone: titleTone, bold: true }, span(`: ${description}`, titleTone));
	} else {
		line.push(span(displayId, titleTone));
	}
	line.push(...agentTypeBadge(result.agent));
	line.push(span(" "), { text: statusText, badge: true, tone });
	appendAgentStats(line, {
		tokens: result.tokens,
		requests: result.requests,
		contextTokens: result.contextTokens,
		contextWindow: result.contextWindow,
		cost: result.usage?.cost.total ?? 0,
		resolvedModel: result.resolvedModel,
		showResolvedModelBadge: settings.get("subagent.showResolvedModelBadge"),
	});
	line.push(DOT, span(formatDuration(result.durationMs), "dim"));
	if (result.truncated) line.push(span(" "), span("[truncated]", "warning"));
	rows.push(openRow(place, line));

	rows.push(...assignmentRows(result.assignment ?? result.task, place, expanded));

	if (aborted && result.abortReason) {
		rows.push(
			detailRow(place, [
				{ text: "", symbol: "status.aborted", tone: "error" },
				span(" "),
				span(previewLine(sanitizeText(result.abortReason), OUTPUT_WARNING_WIDTH), "dim"),
			]),
		);
	}

	// A review verdict, preferring the incremental yield sections and falling back to the older
	// `report_finding` side channel. `normalizeYieldData` guards a slot that is not an array.
	const completeData = normalizeYieldData(result.extractedToolData?.yield);
	const reportFindingData = normalizeReportFindings(result.extractedToolData?.report_finding);
	const incrementalReview = extractIncrementalReviewResult(completeData);
	if (incrementalReview) {
		rows.push(...reviewRows(incrementalReview.summary, incrementalReview.findings, place, expanded));
		return rows;
	}

	const reviewData = completeData
		.map(c => c.data as SubmitReviewDetails)
		.filter(d => d && typeof d === "object" && "overall_correctness" in d);
	if (reviewData.length > 0) {
		rows.push(...reviewRows(reviewData[reviewData.length - 1], reportFindingData, place, expanded));
		return rows;
	}
	if (reportFindingData.length > 0) {
		rows.push(
			detailRow(place, [
				{ text: "", symbol: "status.warning", tone: "warning" },
				span(" "),
				span(
					completeData.length > 0
						? "Review verdict missing expected fields"
						: "Review incomplete (yield not called)",
					"dim",
				),
			]),
		);
		rows.push(detailRow(place, findingSummarySpans(reportFindingData)));
		rows.push(...findingRows(reportFindingData, place, expanded));
		return rows;
	}

	let hasYieldSections = false;
	const nestedRows: TaskRow[] = [];
	if (result.extractedToolData) {
		for (const toolName in result.extractedToolData) {
			const dataArray = result.extractedToolData[toolName];
			if (toolName === YIELD_TOOL_NAME) {
				const yieldRows = yieldSectionRows(dataArray, place, expanded);
				if (yieldRows.length > 0) {
					hasYieldSections = true;
					rows.push(...yieldRows);
				}
				continue;
			}
			// Review data is drawn above, and every other tool's data is drawn by the block that owns it.
			if (toolName === "report_finding") continue;
			if (toolName === "task" && (dataArray as unknown[]).length > 0) {
				nestedRows.push(
					...nestedResultRows(dataArray as TaskToolDetails[], place.depth + 1, expanded, seen, nestedDepth),
				);
			}
		}
	}

	if (hasYieldSections && missingYieldWarning) {
		rows.push(
			detailRow(place, [
				{ text: "", symbol: "status.warning", tone: "warning" },
				span(" "),
				span(truncateToWidth(sanitizeText(missingYieldWarning), OUTPUT_WARNING_WIDTH), "dim"),
			]),
		);
	}

	if (!hasYieldSections) {
		rows.push(...outputRows(outputWithoutWarning, place, expanded, 3, SETTLED_OUTPUT_ROWS, missingYieldWarning));
	}

	rows.push(...nestedRows);

	if (result.patchPath && !aborted && result.exitCode === 0) {
		rows.push(detailRow(place, [span(`Patch: ${result.patchPath}`, "dim")]));
	} else if (result.branchName && !aborted && result.exitCode === 0) {
		rows.push(detailRow(place, [span(`Branch: ${result.branchName}`, "dim")]));
	}

	if (result.error && (!success || mergeFailed) && (!aborted || result.error !== result.abortReason)) {
		rows.push(
			detailRow(place, [
				span(previewLine(sanitizeText(result.error), OUTPUT_LINE_WIDTH), mergeFailed ? "warning" : "error"),
			]),
		);
	}

	return rows;
}

/** Output rows an expanded settled agent shows. */
const SETTLED_OUTPUT_ROWS = 12;

const MISSING_YIELD_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

function extractMissingYieldWarning(output: string): { warning?: string; rest: string } {
	const lines = output.split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	if (!firstLine.startsWith(MISSING_YIELD_WARNING_PREFIX)) return { rest: output };
	const rest = lines
		.slice(1)
		.join("\n")
		.replace(/^\s*\n+/, "");
	return { warning: firstLine, rest };
}

/**
 * Live agents in the order they settle into: finished ones first, by how long they ran, with the
 * unfinished pinned below in dispatch order.
 *
 * A finished agent's runtime is fixed, so the finalized list renders the same order and no row
 * reshuffles as the batch completes.
 */
function orderProgressForDisplay(progress: readonly AgentProgress[]): AgentProgress[] {
	const finished: AgentProgress[] = [];
	const unfinished: AgentProgress[] = [];
	for (const p of progress) (p.status === "pending" || p.status === "running" ? unfinished : finished).push(p);
	finished.sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
	return finished.concat(unfinished);
}

/** Finished agents by runtime ascending, so the settled list matches the live order. */
function orderResultsForDisplay(results: readonly SingleResult[]): SingleResult[] {
	return [...results].sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
}

/** The row standing in for folded live agents: the count and what those agents are doing. */
function hiddenProgressSpans(hidden: readonly AgentProgress[]): ViewSpan[] {
	const counts: Record<AgentProgress["status"], number> = {
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		aborted: 0,
	};
	for (const p of hidden) counts[p.status]++;
	const parts: ViewSpan[] = [];
	const push = (text: string, tone: ViewTone): void => {
		if (parts.length > 0) parts.push(DOT);
		parts.push(span(text, tone));
	};
	if (counts.completed > 0) push(`${counts.completed} done`, "dim");
	if (counts.running > 0) push(`${counts.running} running`, "dim");
	if (counts.pending > 0) push(`${counts.pending} pending`, "dim");
	if (counts.failed > 0) push(`${counts.failed} failed`, "error");
	if (counts.aborted > 0) push(`${counts.aborted} aborted`, "error");
	const line: ViewSpan[] = [span(formatMoreItems(hidden.length, "agent"), "dim")];
	if (parts.length > 0) line.push(span(" (", "dim"), ...parts, span(")", "dim"));
	return line;
}

/**
 * The agent rows a collapsed settled batch keeps.
 *
 * A row that reports a problem claims a slot first, so a failure is never the one folded away, and
 * the fastest finishers fill what is left. The pick is filtered out of the display order, so the
 * rows that stay keep the order the expanded card has.
 */
function selectCollapsedResults(ordered: readonly SingleResult[]): readonly SingleResult[] {
	if (ordered.length <= COLLAPSED_AGENT_LIMIT) return ordered;
	const picked = new Set<SingleResult>();
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		if (result.aborted || result.exitCode !== 0 || result.error) picked.add(result);
	}
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		picked.add(result);
	}
	return ordered.filter(result => picked.has(result));
}

/** A cycle or a depth limit in the tree, stated at the parent's own level. */
function guardRow(depth: number, text: string): TaskRow {
	return { spans: [span(text, "dim")], depth: Math.max(0, depth - 1), opens: false, last: true };
}

/** Nested finished agents, as the children of the agent that spawned them. */
function nestedResultRows(
	detailsList: TaskToolDetails[],
	depth: number,
	expanded: boolean,
	seen: WeakSet<object> = new WeakSet<object>(),
	nestedDepth = 0,
): TaskRow[] {
	const rows: TaskRow[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			rows.push(guardRow(depth, "… nested task progress already shown"));
			continue;
		}
		if (nestedDepth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			rows.push(guardRow(depth, "… nested task depth limit reached"));
			continue;
		}
		seen.add(details);
		if (!details.results || details.results.length === 0) {
			seen.delete(details);
			continue;
		}
		const ordered = orderResultsForDisplay(details.results);
		const visible = expanded ? ordered : selectCollapsedResults(ordered);
		const hiddenCount = ordered.length - visible.length;
		visible.forEach((result, index) => {
			const last = hiddenCount === 0 && index === visible.length - 1;
			rows.push(...resultRows(result, { depth, last }, expanded, seen, nestedDepth + 1));
		});
		if (hiddenCount > 0) {
			rows.push({
				spans: [span(formatMoreItems(hiddenCount, "agent"), "dim")],
				depth,
				opens: true,
				last: true,
			});
		}
		seen.delete(details);
	}
	return rows;
}

/** Nested agents, finished or in flight, as one tree under the agent that spawned them. */
function nestedTreeRows(
	detailsList: TaskToolDetails[],
	depth: number,
	expanded: boolean,
	frozen: boolean,
	seen: WeakSet<object> = new WeakSet<object>(),
	nestedDepth = 0,
): TaskRow[] {
	const rows: TaskRow[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			rows.push(guardRow(depth, "… nested task progress already shown"));
			continue;
		}
		if (nestedDepth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			rows.push(guardRow(depth, "… nested task depth limit reached"));
			continue;
		}
		seen.add(details);
		if (details.results && details.results.length > 0) {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			const hiddenCount = ordered.length - visible.length;
			visible.forEach((result, index) => {
				const last = hiddenCount === 0 && index === visible.length - 1;
				rows.push(...resultRows(result, { depth, last }, expanded, seen, nestedDepth + 1));
			});
			if (hiddenCount > 0) {
				rows.push({ spans: [span(formatMoreItems(hiddenCount, "agent"), "dim")], depth, opens: true, last: true });
			}
			seen.delete(details);
			continue;
		}
		const inflight = details.progress;
		if (inflight && inflight.length > 0) {
			const ordered = orderProgressForDisplay(inflight);
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			const hiddenCount = ordered.length - visible.length;
			visible.forEach((prog, index) => {
				const last = hiddenCount === 0 && index === visible.length - 1;
				rows.push(...progressRows(prog, { depth, last }, expanded, frozen, seen, nestedDepth + 1));
			});
			if (hiddenCount > 0) {
				rows.push({ spans: [span(formatMoreItems(hiddenCount, "agent"), "dim")], depth, opens: true, last: true });
			}
		}
		seen.delete(details);
	}
	return rows;
}

/** The rows of the card's body as the tree section that carries them. */
function treeSection(rows: readonly TaskRow[]): ViewSection {
	const tree: ViewTreeLines = {
		depth: rows.map(row => row.depth),
		opens: rows.map(row => row.opens),
		last: rows.map(row => row.last),
	};
	return { separator: true, lines: rows.map(row => row.spans as ViewLine), tree };
}

/** The row that heads the card, by what the call is doing rather than by how it ended. */
function header(
	status: ViewStatus | undefined,
	emblem: string | undefined,
	...meta: (string | undefined)[]
): StatusRowView {
	const entries = meta.filter((entry): entry is string => entry !== undefined).map(entry => [span(entry)]);
	return {
		kind: "statusRow",
		...(status === undefined ? {} : { status }),
		...(emblem === undefined ? {} : { emblem }),
		title: "Task",
		...(entries.length === 0 ? {} : { meta: entries }),
	};
}

/**
 * The card while the call is still arriving.
 *
 * The dispatch mark from the first frame: spawning does not block the turn, so a pending glyph would
 * read as something the turn is waiting on.
 *
 * The arguments are repaired first. A model that JSON-escaped a prose field twice sends a brief that
 * survived the provider's own decode with every newline and quote still backslashed, and the preview
 * is where a reader would first see the blob; the repair is idempotent on text that is already clean.
 */
function renderCall(rawArgs: unknown, context: ToolViewContext): FramedBlockView {
	const args = repairTaskParams((rawArgs ?? {}) as TaskParams);
	const sections: ViewSection[] = [];
	// Once a result snapshot exists the result card draws the same agents and the same brief, so the
	// call preview would repeat it.
	if (context.hasResult !== true) {
		const contextSection = markdownSection(args?.context, false);
		const assignmentSection = markdownSection(args?.task, false);
		// The result card's order — background, brief, then the agents — so a row does not jump from
		// above the brief to below it when the first snapshot replaces this card. It is also the order
		// the arguments arrive in, so the preview grows downward instead of pushing the brief around.
		if (contextSection) sections.push(contextSection);
		if (assignmentSection) sections.push(assignmentSection);
		const rows = callRows(args);
		if (rows.length > 0) sections.push(treeSection(rows));
	}
	const isolated = "isolated" in args && args.isolated === true;
	return {
		kind: "framedBlock",
		header: header(undefined, "tool.task", agentHeaderLabel(args), isolated ? "isolated" : undefined),
		state: "pending",
		sections,
	};
}

/** The card once the call has spawned something, live or settled. */
function renderResult(result: TaskViewResult, context: ToolViewContext, rawArgs?: unknown): FramedBlockView {
	const args = rawArgs as TaskParams | undefined;
	const expanded = context.expanded === true;
	const partial = context.partial === true;
	const frozen = context.frozen === true;
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;
	const agentLabel = agentHeaderLabel(args);
	const contextSection = markdownSection(args?.context, false);
	const assignmentSection = markdownSection(args?.task, false);

	if (!details) {
		const errored = result.isError === true;
		const sections: ViewSection[] = [];
		if (contextSection) sections.push(contextSection);
		if (assignmentSection) sections.push(assignmentSection);
		if (fallbackText)
			sections.push({
				separator: true,
				lines: [[span(replaceTabs(shortenEmbeddedPaths(fallbackText)), errored ? "error" : "dim")]],
				clip: true,
			});
		return {
			kind: "framedBlock",
			header: errored ? header("error", undefined, agentLabel) : header(undefined, "status.done", agentLabel),
			state: errored ? "error" : "success",
			sections,
		};
	}

	// One pass over the results derives the header's counts and the footer's totals both: the card
	// repaints on every frame while agents are live, and this used to be seven passes a tick.
	let abortedCount = 0;
	let failCount = 0;
	let mergeFailedCount = 0;
	let successCount = 0;
	let requestTotal = 0;
	const hasResults = Boolean(details.results && details.results.length > 0);
	if (hasResults) {
		for (const r of details.results) {
			requestTotal += r.requests ?? 0;
			switch (classifySubagentOutcome(r).kind) {
				case "aborted":
					abortedCount++;
					break;
				case "failed":
					failCount++;
					break;
				case "merge-failed":
					mergeFailedCount++;
					break;
				default:
					successCount++;
			}
		}
	}
	const isError = abortedCount > 0 || failCount > 0;
	const mergeFailed = mergeFailedCount > 0;
	const refused = details.warning !== undefined;
	const agentCount = hasResults ? details.results.length : (details.progress?.length ?? 0);
	// The header's fact is the spawn count alone; each row carries its own agent badge, so a joined
	// list of types here would repeat them. Before anything spawns it falls back to the call's type.
	const countLabel = agentCount > 0 ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : undefined;
	const state: ViewStatus = partial
		? "running"
		: refused
			? "warning"
			: isError
				? "error"
				: mergeFailed
					? "warning"
					: "success";
	// While agents are in flight the header keeps the dispatch mark rather than a spinner: an async
	// spawn returns at once, so "running" means delegated rather than blocking.
	const headerRow =
		state === "running"
			? header(undefined, "tool.task", countLabel ?? agentLabel)
			: state === "success"
				? header(undefined, "status.done", countLabel ?? agentLabel)
				: header(state, undefined, countLabel ?? agentLabel);

	const rows: TaskRow[] = [];
	// Result rows win once any exist; a spawn with no result of its own — a mixed call's async half —
	// keeps its live row below them.
	const showProgress = Boolean(details.progress && details.progress.length > 0) && details.results.length === 0;
	if (showProgress && details.progress) {
		const ordered = orderProgressForDisplay(details.progress);
		// Folding from the top keeps the live edge: finished rows sort first, so a collapsed card
		// stands one summary row in for them and keeps the agents still working.
		const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
		if (visible.length < ordered.length) {
			rows.push(openRow(TOP, hiddenProgressSpans(ordered.slice(0, ordered.length - visible.length))));
		}
		for (const progress of visible) rows.push(...progressRows(progress, TOP, expanded, frozen, undefined, 0));
	} else if (details.results && details.results.length > 0) {
		const ordered = orderResultsForDisplay(details.results);
		const visible = expanded ? ordered : selectCollapsedResults(ordered);
		for (const res of visible) rows.push(...resultRows(res, TOP, expanded, undefined, 0));
		if (visible.length < ordered.length) {
			rows.push(openRow(TOP, [span(formatMoreItems(ordered.length - visible.length, "agent"), "dim")]));
		}

		// A mixed call: an async spawn never lands in `results`, since its payload arrives through a
		// job, so its row stays beside the finalized ones — live while it runs, settled once it lands.
		const supplemental = details.progress
			? orderProgressForDisplay(details.progress.filter(p => !details.results.some(res => res.id === p.id)))
			: [];
		for (const progress of supplemental) rows.push(...progressRows(progress, TOP, expanded, frozen, undefined, 0));

		const summary: ViewSpan[] = [{ text: "", symbol: "format.bracketLeft", tone: "dim" }];
		const parts: ViewSpan[] = [];
		const push = (text: string, tone: ViewTone): void => {
			if (parts.length > 0) parts.push(DOT);
			parts.push(span(text, tone));
		};
		if (abortedCount > 0) push(`${abortedCount} aborted`, "error");
		if (successCount > 0) push(`${successCount} succeeded`, "success");
		if (mergeFailedCount > 0) push(`${mergeFailedCount} merge failed`, "warning");
		if (failCount > 0) push(`${failCount} failed`, "error");
		if (requestTotal > 0) push(`${formatNumber(requestTotal)} req`, "dim");
		push(formatDuration(details.totalDurationMs), "dim");
		summary.push(...parts, { text: "", symbol: "format.bracketRight", tone: "dim" });
		rows.push(openRow(TOP, summary));
	}

	const sections: ViewSection[] = [];
	if (contextSection) sections.push(contextSection);
	if (assignmentSection) sections.push(assignmentSection);

	if (rows.length === 0) {
		const text = fallbackText.trim() ? replaceTabs(shortenEmbeddedPaths(fallbackText)) : "No results";
		sections.push({ separator: true, lines: [[span(text, refused ? "warning" : "dim")]], clip: true });
		return { kind: "framedBlock", header: headerRow, state, sections };
	}

	// A summary the tool wrote for the model — the patches it applied, a notification — is the one
	// part of the text result the card repeats, because nothing above it says whether the work landed.
	if (fallbackText.trim()) {
		const summaryLines = fallbackText.split("\n");
		const markerIndex = summaryLines.findIndex(
			line =>
				line.includes("<system-notification>") ||
				line.startsWith("Applied patches:") ||
				line.startsWith("No changes to apply."),
		);
		if (markerIndex >= 0) {
			for (const line of summaryLines.slice(markerIndex)) {
				if (!line.trim()) continue;
				rows.push(openRow(TOP, [span(replaceTabs(shortenEmbeddedPaths(line)), "dim")]));
			}
		}
	}

	sections.push(treeSection(rows));
	return { kind: "framedBlock", header: headerRow, state, sections };
}

/**
 * The task tool's card, for any host.
 *
 * The argument type is `unknown` because the task schema is built at run time from the agents a
 * session may spawn, so the tool's own parameter type erases to `unknown` and every caller — the
 * live call path, a rebuilt transcript, the renderer table — hands over whatever the model sent,
 * half parsed while it is still arriving. Each entry point narrows once, and every field read below
 * it is already defensive for the same reason.
 */
export const taskToolView: Required<ToolViewRenderer<unknown, TaskViewResult>> = {
	renderCall,
	renderResult,
};
