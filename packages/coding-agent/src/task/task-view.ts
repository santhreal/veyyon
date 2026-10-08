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
import {
	type FindingPriority,
	findingTitle,
	getPriorityInfo,
	normalizeReportFindings,
	PRIORITY_LABELS,
	priorityTone,
	type ReportFindingDetails,
	type SubmitReviewDetails,
} from "../tools/agent/review";
import { jsonTreeViewLines } from "../tools/core/json-tree-view";
import {
	extractResultText,
	formatDuration,
	formatMoreItems,
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	type ToolViewResult,
	truncateToWidth,
} from "../tools/core/render-utils";
import { appendAgentStats, STATS_DOT, sanitizeRecentOutput, span } from "./agent-stats";
import { type AgentOutcomeKind, classifyAgentOutcome } from "./outcome";
import { repairDoubleEncodedJsonString, repairTaskParams } from "./repair-args";
import { DEFAULT_SPAWN_AGENT } from "./spawn-policy";
import { YIELD_TOOL_NAME } from "./subprocess-tool-registry";
import { formatTaskId } from "./task-id";
import type { AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails, YieldItem } from "./types";
import { assembleYieldResult, getYieldLabels } from "./yield-assembly";

/** What the tool returns, as the card reads it. */
export interface TaskViewResult extends ToolViewResult<TaskToolDetails> {}

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

function pushDotSpan(target: ViewSpan[], text: string, tone: ViewTone): void {
	if (target.length > 0) target.push(STATS_DOT);
	target.push(span(text, tone));
}

/** The two columns a section's own body sits in, under the line that names it. */
const INSET: ViewSpan = { text: "  " };

/** The mark a warning row opens with. */
const WARNING_MARK: ViewSpan = { text: "", symbol: "status.warning", tone: "warning" };

/** The mark a detail hanging off the row above it opens with: the tool an agent runs, the recovery it waits on. */
const HOOK: ViewSpan = { text: "", symbol: "tree.hook", tone: "dim" };

/** What every agent row in one card is drawn with. */
interface CardOptions {
	readonly expanded: boolean;
	readonly showResolvedModelBadge: boolean;
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
		if (index > 0) line.push(STATS_DOT);
		const tone = priorityTone(label);
		line.push(
			{ text: "", symbol: getPriorityInfo(label).symbol, tone },
			span(" "),
			span(`${label}:${counts[label] ?? 0}`, tone),
		);
	});
	return line;
}

const REVIEWER_ARRAY_LABELS: ReadonlySet<string> = new Set(["findings"]);

function extractIncrementalReviewResult(
	items: YieldItem[],
): { summary: SubmitReviewDetails; findings: ReportFindingDetails[] } | undefined {
	const assembled = assembleYieldResult(items, undefined, REVIEWER_ARRAY_LABELS);
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
function extractReviewDetails(extractedToolData: Record<string, unknown> | undefined):
	| {
			summary: SubmitReviewDetails;
			findings: ReportFindingDetails[];
	  }
	| undefined {
	if (!extractedToolData) return undefined;
	const completeData = normalizeYieldData(extractedToolData.yield);
	const incrementalReview = extractIncrementalReviewResult(completeData);
	if (incrementalReview) return incrementalReview;
	for (let i = completeData.length - 1; i >= 0; i--) {
		const d = completeData[i].data;
		if (d && typeof d === "object" && "overall_correctness" in d) {
			return {
				summary: d as unknown as SubmitReviewDetails,
				findings: normalizeReportFindings(extractedToolData.report_finding),
			};
		}
	}
	return undefined;
}

/**
 * The `yield` slot of `extractedToolData` as a list of yield records.
 *
 * The executor always fills the slot with an array, and a stray single object still has to survive:
 * optional chaining short-circuits on `null` and `undefined` alone, so `.map` on a plain object
 * threw and took the card with it. A lone object is read as a one-entry list and a primitive drops.
 */
function normalizeYieldData(value: unknown): YieldItem[] {
	const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const normalized: YieldItem[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const status = record.status;
		normalized.push({
			data: record.data,
			type: yieldItemType(record.type),
			status: status === "aborted" || status === "success" ? status : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
		});
	}
	return normalized;
}

/** A yield record's label: a string, or a list of strings copied out of the record; anything else is no label. */
function yieldItemType(value: unknown): YieldItem["type"] {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const labels: string[] = [];
	for (const label of value) {
		if (typeof label !== "string") return undefined;
		labels.push(label);
	}
	return labels;
}

function formatYieldPreview(item: YieldItem): string {
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

/** The yield sections an agent filed, newest last. Returns whether it drew any. */
function appendYieldSections(rows: TaskRow[], value: unknown, place: NodePlace, expanded: boolean): boolean {
	const typedItems: Array<{ item: YieldItem; labels: string[] }> = [];
	for (const item of normalizeYieldData(value)) {
		const labels = getYieldLabels(item.type);
		if (labels.length === 0) continue;
		typedItems.push({ item, labels });
	}
	const displayCount = expanded ? typedItems.length : COLLAPSED_YIELD_LIMIT;
	for (const { item, labels } of typedItems.slice(-displayCount)) {
		const terminal = !Array.isArray(item.type);
		const label = `${terminal ? "yield" : "yield+"}[${labels.join(", ")}]`;
		rows.push(detailRow(place, [span(label, "dim"), span(": "), span(formatYieldPreview(item), "dim")]));
	}
	if (typedItems.length > displayCount) {
		rows.push(detailRow(place, [span(formatMoreItems(typedItems.length - displayCount, "yield"), "dim")]));
	}
	return typedItems.length > 0;
}

/** Columns one line of an agent's output may spend before it is cut. */
const OUTPUT_LINE_WIDTH = 70;

/** Columns a warning above an agent's output may spend. */
const OUTPUT_WARNING_WIDTH = 80;

function appendTruncatedLines(target: TaskRow[], lines: readonly string[], place: NodePlace, cap: number): void {
	for (const line of lines.slice(0, cap)) {
		target.push(detailRow(place, [INSET, span(truncateToWidth(replaceTabs(line), OUTPUT_LINE_WIDTH), "dim")]));
	}
	if (lines.length > cap) {
		target.push(detailRow(place, [INSET, span(formatMoreItems(lines.length - cap, "line"), "dim")]));
	}
}

/**
 * What an agent returned: a JSON value as a tree, or its output as lines.
 *
 * The warning an agent that never called `yield` carries opens the section, because it is the reason
 * the output below it is whatever the process happened to print.
 */
function appendOutput(
	rows: TaskRow[],
	output: string,
	place: NodePlace,
	expanded: boolean,
	maxLines: number,
	warning?: string,
): void {
	const trimmedOutput = sanitizeText(output).trimEnd();
	if (warning) {
		rows.push(
			detailRow(place, [span("Output", "dim")]),
			detailRow(place, [
				INSET,
				WARNING_MARK,
				span(" "),
				span(truncateToWidth(sanitizeText(warning), OUTPUT_WARNING_WIDTH), "dim"),
			]),
		);
	}
	if (!trimmedOutput) return;
	const headed = Boolean(warning);
	if (
		(trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) &&
		appendJsonOutput(rows, trimmedOutput, place, expanded, headed)
	) {
		return;
	}
	if (!headed) rows.push(detailRow(place, [span("Output", "dim")]));
	appendTruncatedLines(rows, trimmedOutput.split("\n"), place, maxLines);
}

/**
 * A returned JSON value: one summary line when collapsed, a tree when expanded.
 *
 * Returns false, drawing nothing, when the text is not JSON or is a value with no tree to draw such as
 * `{}`, so the caller prints the text as lines under the one `Output` heading. `headed` is whether
 * that heading is already drawn above, in which case the summary line sits in its inset.
 */
function appendJsonOutput(
	rows: TaskRow[],
	text: string,
	place: NodePlace,
	expanded: boolean,
	headed: boolean,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	// Collapsed: the same one-line summary the arguments of a call get.
	if (!expanded) {
		const summary = span(formatOutputInline(parsed), "dim");
		rows.push(detailRow(place, headed ? [INSET, summary] : [summary]));
		return true;
	}
	const tree = jsonTreeViewLines(parsed, {
		maxDepth: JSON_TREE_DEPTH,
		maxLines: JSON_TREE_LINES,
		maxScalarLen: OUTPUT_LINE_WIDTH,
	});
	if (tree.lines.length === 0) return false;
	if (!headed) rows.push(detailRow(place, [span("Output", "dim")]));
	for (const line of tree.lines) rows.push(detailRow(place, [INSET, ...line]));
	if (tree.truncated) rows.push(detailRow(place, [INSET, span("…", "dim")]));
	return true;
}

/** Levels of a returned JSON value an expanded card walks, and the lines it may spend on them. */
const JSON_TREE_DEPTH = 6;
const JSON_TREE_LINES = 24;

/** Lines of an agent's brief an expanded card shows. */
const ASSIGNMENT_ROWS = 20;

/** The brief an agent was given, which an expanded card shows under its row. */
function appendAssignment(rows: TaskRow[], task: string | undefined, place: NodePlace, expanded: boolean): void {
	if (!task || !expanded) return;
	const trimmed = sanitizeText(task).trim();
	if (!trimmed) return;
	rows.push(detailRow(place, [span("Task", "dim")]));
	appendTruncatedLines(rows, trimmed.split("\n"), place, ASSIGNMENT_ROWS);
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
function pushAgentTypeBadge(line: ViewSpan[], agent: string | undefined): void {
	const trimmed = agent?.trim();
	if (trimmed && trimmed !== DEFAULT_SPAWN_AGENT) line.push(span(" "), { text: trimmed, badge: true, tone: "dim" });
}

/** Columns an agent's brief may spend on the row that names it. */
const BRIEF_WIDTH = 64;

function callEntryRow(idLabel: string, brief: string, agent?: string, isolated?: boolean): TaskRow {
	const line: ViewSpan[] = [span("•", "dim"), span(" "), { text: idLabel, tone: "accent", bold: true }];
	if (brief) line.push(span(": "), span(previewLine(brief, BRIEF_WIDTH), "muted"));
	pushAgentTypeBadge(line, agent);
	if (isolated) line.push(span(" [isolated]", "dim"));
	return openRow(TOP, line);
}

/** The agent a call is spawning, while its arguments are still arriving. */
function callRows(args: Partial<TaskParams> | undefined): TaskRow[] {
	if (!args) return [];
	const rows: TaskRow[] = [];
	const rawName = typeof args.name === "string" ? args.name.trim() : "";
	const idLabel = rawName ? formatTaskId(rawName) : "";
	const brief = taskFirstLine(args.task);
	if (idLabel || brief) {
		rows.push(callEntryRow(idLabel || "agent", brief, args.agent));
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
		rows.push(callEntryRow(idLabel, taskFirstLine(item?.task), item?.agent, item?.isolated === true));
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
function appendMarkdownBriefSections(target: ViewSection[], args?: Partial<TaskParams>): void {
	const contextSection = markdownSection(args?.context, false);
	if (contextSection) target.push(contextSection);
	const assignmentSection = markdownSection(args?.task, false);
	if (assignmentSection) target.push(assignmentSection);
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
function appendProgress(
	rows: TaskRow[],
	progress: AgentProgress,
	place: NodePlace,
	card: CardOptions,
	frozen: boolean,
	seen: WeakSet<object> | undefined,
	nestedDepth: number,
): void {
	const running = progress.status === "running";
	rows.push(openRow(place, progressHeadline(progress, frozen, card.showResolvedModelBadge)));
	appendAssignment(rows, progress.assignment ?? progress.task, place, card.expanded);
	if (running) appendProgressTool(rows, progress, place);
	appendRecovery(rows, progress, place);

	// A finished reviewer states its verdict from the yield sections it assembled, falling back to
	// the older `report_finding` side channel.
	const review = progress.status === "completed" ? extractReviewDetails(progress.extractedToolData) : undefined;
	if (review) {
		appendReview(rows, review.summary, review.findings, place, card.expanded);
		return;
	}
	if (progress.extractedToolData) appendLiveSections(rows, progress.extractedToolData, place, card.expanded);
	// The nested tree: the sub-calls this agent finished plus the one it is inside, so deep progress
	// reaches the reader without waiting for this agent's own turn to end.
	const finished = (progress.extractedToolData?.task as TaskToolDetails[] | undefined) ?? [];
	const inflight = progress.inflightTaskDetails;
	if (finished.length > 0 || inflight) {
		const snapshots = inflight ? [...finished, inflight] : finished;
		appendNestedTree(rows, snapshots, place.depth + 1, card, frozen, seen, nestedDepth);
	}
	if (card.expanded && running) {
		appendOutput(rows, liveOutput(progress.recentOutput), place, true, LIVE_OUTPUT_ROWS);
	}
}

/**
 * The row that opens a live or queued agent: its mark, id, description, type and badge, then for a
 * running one its brief when it has no description, and its counts once it runs or completes.
 */
function progressHeadline(progress: AgentProgress, frozen: boolean, showResolvedModelBadge: boolean): ViewSpan[] {
	const running = progress.status === "running";
	const trimmedDescription = progress.description?.trim();
	const description = trimmedDescription ? previewLine(sanitizeText(trimmedDescription), BRIEF_WIDTH) : undefined;
	const line = progressTitleSpans(progress, description, frozen);
	pushAgentTypeBadge(line, progress.agent);
	const badge = progressBadge(progress);
	if (badge) line.push(span(" "), badge);
	if (running && !description) {
		line.push(
			span(" "),
			span(previewLine(sanitizeText(progress.assignment ?? progress.task), TOOL_DETAIL_WIDTH), "muted"),
		);
	}
	if (running || progress.status === "completed") {
		appendAgentStats(line, {
			toolCount: progress.toolCount,
			requests: progress.requests,
			tokens: progress.tokens,
			contextTokens: progress.contextTokens,
			contextWindow: progress.contextWindow,
			cost: progress.cost,
			resolvedModel: progress.resolvedModel,
			showResolvedModelBadge,
		});
	}
	return line;
}

/** An agent's id, bold and followed by its description when it has one. */
function pushTitle(line: ViewSpan[], id: string, description: string | undefined, tone: ViewTone): void {
	const text = formatTaskId(id);
	if (description) line.push({ text, tone, bold: true, agentId: id }, span(`: ${description}`, tone));
	else line.push({ text, tone, agentId: id });
}

/** The mark, id and description that open a live or queued agent's row. */
function progressTitleSpans(progress: AgentProgress, description: string | undefined, frozen: boolean): ViewSpan[] {
	if (progress.status === "running" || progress.status === "pending") {
		const tone: ViewTone = frozen ? "dim" : "accent";
		const text = formatTaskId(progress.id);
		const line: ViewSpan[] = [
			{ text: "", symbol: "status.done", tone },
			span(" "),
			description === undefined
				? { text, tone, agentId: progress.id }
				: { text, tone, bold: true, agentId: progress.id },
		];
		if (description) line.push(span(":", tone), span(" "), span(description, tone));
		return line;
	}
	// A finished row settles from the accent to the card's own body text: completion reads as a
	// colour change rather than as a new mark, mark included.
	const completed = progress.status === "completed";
	const line: ViewSpan[] = [
		completed
			? { text: "", symbol: "status.done", tone: "text" }
			: { text: "", status: statusOf(progress.status), tone: "error" },
		span(" "),
	];
	pushTitle(line, progress.id, description, completed ? "text" : "accent");
	return line;
}

/**
 * The badge a live agent's row carries, if any.
 *
 * A recovery badge says the child is sleeping between attempts rather than progressing. It wins over
 * the plain running mark, because waiting is the operationally meaningful state. Once a recovery gave
 * up, the badge names the recovery and never a cause: `retryFailure` is set from any unsuccessful
 * recovery, and the row under it already says which one.
 */
function progressBadge(progress: AgentProgress): ViewSpan | undefined {
	if (progress.retryState && progress.status === "running") {
		return {
			text: progress.retryState.mode === "continue" ? "continuing" : "retrying",
			badge: true,
			tone: "warning",
		};
	}
	if (progress.status !== "failed" && progress.status !== "aborted") return undefined;
	if (progress.retryFailure) {
		return {
			text: progress.retryFailure.mode === "continue" ? "continuation gave up" : "retries gave up",
			badge: true,
			tone: "error",
		};
	}
	return { text: progress.status, badge: true, tone: "error" };
}

/**
 * The tool a running agent is inside, with how long it has run once that is slow; between tools, the
 * last one that finished.
 */
function appendProgressTool(rows: TaskRow[], progress: AgentProgress, place: NodePlace): void {
	const current = progress.currentTool;
	if (!current && progress.recentTools.length === 0) return;
	const recent = progress.recentTools[0];
	const line: ViewSpan[] = [
		HOOK,
		span(" "),
		current ? span(sanitizeText(current), "muted") : span(sanitizeText(recent.tool), "dim"),
	];
	const detail = progress.lastIntent ?? (current ? progress.currentToolArgs : recent.args);
	if (detail) line.push(span(": "), span(previewLine(sanitizeText(detail), TOOL_DETAIL_WIDTH), "dim"));
	const elapsed = current && progress.currentToolStartMs ? Date.now() - progress.currentToolStartMs : 0;
	if (elapsed > SLOW_TOOL_MS) line.push(STATS_DOT, span(formatDuration(elapsed), "warning"));
	rows.push(detailRow(place, line));
}

/**
 * Why the agent is paused and roughly how long until the next attempt, or the recovery that gave up.
 * Without it the card spins while a child sleeps out a three-hour provider rate limit.
 */
function appendRecovery(rows: TaskRow[], progress: AgentProgress, place: NodePlace): void {
	const { retryState, retryFailure } = progress;
	if (retryState && progress.status === "running") {
		const remainingMs = Math.max(0, retryState.startedAtMs + retryState.delayMs - Date.now());
		const waitLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "now";
		// A continuation is not a retry: the batch cannot be resent, so the child carries the turn
		// forward instead, and saying "retrying" named the one thing that did not happen.
		const verb = retryState.mode === "continue" ? "continuing" : "retrying";
		const message = previewLine(sanitizeText(retryState.errorMessage), RETRY_MESSAGE_WIDTH);
		const summary = `${verb} ${retryState.attempt}/${retryState.maxAttempts} ${waitLabel}: ${message}`;
		rows.push(detailRow(place, [HOOK, span(" "), span(summary, "warning")]));
		return;
	}
	if (!retryFailure || progress.status === "running") return;
	const gaveUp = retryFailure.mode === "continue" ? "continuation" : "auto-retry";
	const message = previewLine(sanitizeText(retryFailure.errorMessage), OUTPUT_WARNING_WIDTH);
	const summary = `${gaveUp} gave up after ${formatCount("attempt", retryFailure.attempt)}: ${message}`;
	rows.push(detailRow(place, [HOOK, span(" "), span(summary, "error")]));
}

/**
 * The yield sections and filed findings of an agent that has not settled into a review verdict.
 * Nested task data has its own tree, which also merges in the in-flight snapshot.
 */
function appendLiveSections(
	rows: TaskRow[],
	data: Record<string, unknown[]>,
	place: NodePlace,
	expanded: boolean,
): void {
	for (const toolName in data) {
		if (toolName === YIELD_TOOL_NAME) {
			appendYieldSections(rows, data[toolName], place, expanded);
		} else if (toolName === "report_finding") {
			const findings = normalizeReportFindings(data[toolName]);
			if (findings.length === 0) continue;
			rows.push(detailRow(place, findingSummarySpans(findings)));
			appendFindings(rows, findings, place, expanded);
		}
	}
}

/** Columns a retry's own error message may spend. */
const RETRY_MESSAGE_WIDTH = 60;

/**
 * The newest rows of a live agent's output, oldest of them replaced by a count.
 *
 * The rows arrive newest first, so they are reversed into reading order and the front is what a
 * window drops.
 */
function liveOutput(recentOutput: readonly string[] | undefined): string {
	if (!recentOutput || recentOutput.length === 0) return "";
	const rows = sanitizeRecentOutput([...recentOutput].reverse().join("\n")).split("\n");
	if (rows.length <= LIVE_OUTPUT_ROWS) return rows.join("\n");
	const visible = LIVE_OUTPUT_ROWS <= 1 ? [] : rows.slice(rows.length - (LIVE_OUTPUT_ROWS - 1));
	const hidden = rows.length - visible.length;
	return [`… ${hidden} earlier ${hidden === 1 ? "line" : "lines"}`, ...visible].join("\n");
}

/** A reviewer's verdict, its explanation and the findings it filed. */
function appendReview(
	rows: TaskRow[],
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	place: NodePlace,
	expanded: boolean,
): void {
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
	if (findings.length > 0) appendFindings(rows, findings, place, expanded);
}

/** Columns a collapsed review explanation may spend. */
const EXPLANATION_WIDTH = 100;

/** Findings a collapsed card names, most severe first. */
const COLLAPSED_FINDING_LIMIT = 3;

/** One node per finding, under the agent that filed it. */
function appendFindings(rows: TaskRow[], findings: ReportFindingDetails[], place: NodePlace, expanded: boolean): void {
	const sorted = expanded
		? findings
		: [...findings].sort((a, b) => getPriorityInfo(a.priority).ord - getPriorityInfo(b.priority).ord);
	const displayCount = expanded ? sorted.length : Math.min(COLLAPSED_FINDING_LIMIT, sorted.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = sorted[i];
		const isLast = i === displayCount - 1 && (expanded || sorted.length <= COLLAPSED_FINDING_LIMIT);
		const at: NodePlace = { depth: place.depth + 1, last: isLast };
		const title = replaceTabs(sanitizeText(findingTitle(finding.title ?? "Untitled"))).replace(/[\r\n]+/g, " ");
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
}

/** One finished agent: how it ended, what it spent, and what it returned. */
function appendResult(
	rows: TaskRow[],
	result: SingleResult,
	place: NodePlace,
	card: CardOptions,
	seen: WeakSet<object> | undefined,
	nestedDepth: number,
): void {
	const { warning: missingYieldWarning, rest: outputWithoutWarning } = extractMissingYieldWarning(result.output);
	// The same classification the wire uses, so a row cannot read as done while the tool result is
	// marked an error, or the reverse.
	const kind = classifyAgentOutcome(result).kind;
	const look = RESULT_LOOKS[kind === "completed" && missingYieldWarning ? "unyielded" : kind];
	rows.push(openRow(place, resultHeadline(result, look, card.showResolvedModelBadge)));
	appendAssignment(rows, result.assignment ?? result.task, place, card.expanded);
	if (kind === "aborted" && result.abortReason) {
		rows.push(
			detailRow(place, [
				{ text: "", symbol: "status.aborted", tone: "error" },
				span(" "),
				span(previewLine(sanitizeText(result.abortReason), OUTPUT_WARNING_WIDTH), "dim"),
			]),
		);
	}
	if (appendVerdict(rows, result.extractedToolData, place, card.expanded)) return;
	if (!appendYieldSections(rows, result.extractedToolData?.[YIELD_TOOL_NAME], place, card.expanded)) {
		const maxLines = card.expanded ? SETTLED_OUTPUT_ROWS : 3;
		appendOutput(rows, outputWithoutWarning, place, card.expanded, maxLines, missingYieldWarning);
	} else if (missingYieldWarning) {
		rows.push(
			detailRow(place, [
				WARNING_MARK,
				span(" "),
				span(truncateToWidth(sanitizeText(missingYieldWarning), OUTPUT_WARNING_WIDTH), "dim"),
			]),
		);
	}
	// Review data is drawn above, and every other tool's data is drawn by the block that owns it.
	const nested = result.extractedToolData?.task as TaskToolDetails[] | undefined;
	if (nested && nested.length > 0) appendNestedTree(rows, nested, place.depth + 1, card, undefined, seen, nestedDepth);
	appendSettlement(rows, result, kind, look, place);
}

/** How a finished agent's row reads: the mark that opens it, its badge, and the tones of both. */
interface ResultLook {
	readonly mark: ViewSpan;
	readonly badge: string;
	readonly tone: ViewTone;
	readonly titleTone: ViewTone;
}

/** Each way an agent can settle, plus a completed agent that never called `yield`, which reads as a warning. */
const RESULT_LOOKS: Record<AgentOutcomeKind | "unyielded", ResultLook> = {
	aborted: {
		mark: { text: "", status: "aborted", tone: "error" },
		badge: "aborted",
		tone: "error",
		titleTone: "accent",
	},
	failed: {
		mark: { text: "", symbol: "status.error", tone: "error" },
		badge: "failed",
		tone: "error",
		titleTone: "accent",
	},
	"merge-failed": {
		mark: { text: "", symbol: "status.error", tone: "warning" },
		badge: "merge failed",
		tone: "warning",
		titleTone: "accent",
	},
	unyielded: { mark: WARNING_MARK, badge: "warning", tone: "warning", titleTone: "accent" },
	// Settled: the mark and the title take the card's body text, like the row they open.
	completed: {
		mark: { text: "", symbol: "status.done", tone: "text" },
		badge: "done",
		tone: "success",
		titleTone: "text",
	},
};

/** The row that opens a finished agent: its mark, id, description, badge, counts and runtime. */
function resultHeadline(result: SingleResult, look: ResultLook, showResolvedModelBadge: boolean): ViewSpan[] {
	const trimmedDescription = result.description ? sanitizeText(result.description).trim() : undefined;
	const description = trimmedDescription ? previewLine(trimmedDescription, BRIEF_WIDTH) : undefined;
	const line: ViewSpan[] = [look.mark, span(" ")];
	pushTitle(line, result.id, description, look.titleTone);
	pushAgentTypeBadge(line, result.agent);
	line.push(span(" "), { text: look.badge, badge: true, tone: look.tone });
	appendAgentStats(line, {
		tokens: result.tokens,
		requests: result.requests,
		contextTokens: result.contextTokens,
		contextWindow: result.contextWindow,
		cost: result.usage?.cost.total ?? 0,
		resolvedModel: result.resolvedModel,
		showResolvedModelBadge,
	});
	line.push(STATS_DOT, span(formatDuration(result.durationMs), "dim"));
	if (result.truncated) line.push(span(" "), span("[truncated]", "warning"));
	return line;
}

/**
 * A reviewer's verdict, preferring the incremental yield sections and falling back to the older
 * `report_finding` side channel; findings filed with no verdict say the verdict is missing.
 * Returns false, drawing nothing, when the agent filed neither. `normalizeYieldData` guards a slot
 * that is not an array.
 */
function appendVerdict(
	rows: TaskRow[],
	data: Record<string, unknown[]> | undefined,
	place: NodePlace,
	expanded: boolean,
): boolean {
	const review = extractReviewDetails(data);
	if (review) {
		appendReview(rows, review.summary, review.findings, place, expanded);
		return true;
	}
	const findings = normalizeReportFindings(data?.report_finding);
	if (findings.length === 0) return false;
	const missing =
		normalizeYieldData(data?.yield).length > 0
			? "Review verdict missing expected fields"
			: "Review incomplete (yield not called)";
	rows.push(
		detailRow(place, [WARNING_MARK, span(" "), span(missing, "dim")]),
		detailRow(place, findingSummarySpans(findings)),
	);
	appendFindings(rows, findings, place, expanded);
	return true;
}

/** Where an isolated agent's work went, and the error an agent that did not complete ended on. */
function appendSettlement(
	rows: TaskRow[],
	result: SingleResult,
	kind: AgentOutcomeKind,
	look: ResultLook,
	place: NodePlace,
): void {
	const aborted = kind === "aborted";
	if (!aborted && result.exitCode === 0) {
		if (result.patchPath) rows.push(detailRow(place, [span(`Patch: ${result.patchPath}`, "dim")]));
		else if (result.branchName) rows.push(detailRow(place, [span(`Branch: ${result.branchName}`, "dim")]));
	}
	// A set error never classifies as completed, and an abort's reason is already drawn under its row.
	if (result.error && (!aborted || result.error !== result.abortReason)) {
		rows.push(detailRow(place, [span(previewLine(sanitizeText(result.error), OUTPUT_LINE_WIDTH), look.tone)]));
	}
}

/** Output rows an expanded settled agent shows. */
const SETTLED_OUTPUT_ROWS = 12;

/** The runtime's spelling and the one a session file recorded before the `subagent` vocabulary was retired. */
const MISSING_YIELD_WARNING_PREFIXES = [
	"SYSTEM WARNING: Agent exited without calling yield tool",
	"SYSTEM WARNING: Subagent exited without calling yield tool",
];

function extractMissingYieldWarning(output: string = ""): { warning?: string; rest: string } {
	const lines = (output ?? "").split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	if (!MISSING_YIELD_WARNING_PREFIXES.some(prefix => firstLine.startsWith(prefix))) return { rest: output };
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
	if (counts.completed > 0) pushDotSpan(parts, `${counts.completed} done`, "dim");
	if (counts.running > 0) pushDotSpan(parts, `${counts.running} running`, "dim");
	if (counts.pending > 0) pushDotSpan(parts, `${counts.pending} pending`, "dim");
	if (counts.failed > 0) pushDotSpan(parts, `${counts.failed} failed`, "error");
	if (counts.aborted > 0) pushDotSpan(parts, `${counts.aborted} aborted`, "error");
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

/** Nested agents, finished or in flight, as one tree under the agent that spawned them. */
function appendNestedTree(
	rows: TaskRow[],
	detailsList: TaskToolDetails[],
	depth: number,
	card: CardOptions,
	// Undefined excludes live progress from completed-result snapshots.
	frozen: boolean | undefined,
	seen: WeakSet<object> = new WeakSet<object>(),
	nestedDepth = 0,
): void {
	for (const details of detailsList) {
		if (seen.has(details)) {
			rows.push(guardRow(depth, "… nested task progress already shown"));
		} else if (nestedDepth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			rows.push(guardRow(depth, "… nested task depth limit reached"));
		} else {
			seen.add(details);
			appendNestedCall(rows, details, depth, card, frozen, seen, nestedDepth + 1);
			seen.delete(details);
		}
	}
}

/** One nested call's agents: its results once it has any, else its live progress unless `frozen` is undefined. */
function appendNestedCall(
	rows: TaskRow[],
	details: TaskToolDetails,
	depth: number,
	card: CardOptions,
	frozen: boolean | undefined,
	seen: WeakSet<object>,
	nestedDepth: number,
): void {
	if (details.results && details.results.length > 0) {
		const ordered = orderResultsForDisplay(details.results);
		const visible = card.expanded ? ordered : selectCollapsedResults(ordered);
		appendSiblings(rows, visible, ordered.length, depth, (result, place) =>
			appendResult(rows, result, place, card, seen, nestedDepth),
		);
		return;
	}
	const inflight = details.progress;
	if (frozen === undefined || !inflight || inflight.length === 0) return;
	const ordered = orderProgressForDisplay(inflight);
	const visible = card.expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
	appendSiblings(rows, visible, ordered.length, depth, (progress, place) =>
		appendProgress(rows, progress, place, card, frozen, seen, nestedDepth),
	);
}

/** The visible agents of a nested call as sibling nodes, closed by a count of the ones folded away. */
function appendSiblings<T>(
	rows: TaskRow[],
	visible: readonly T[],
	total: number,
	depth: number,
	appendAgent: (agent: T, place: NodePlace) => void,
): void {
	const hiddenCount = total - visible.length;
	for (let index = 0; index < visible.length; index++) {
		appendAgent(visible[index], { depth, last: hiddenCount === 0 && index === visible.length - 1 });
	}
	if (hiddenCount > 0) rows.push(openRow({ depth, last: true }, [span(formatMoreItems(hiddenCount, "agent"), "dim")]));
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

/**
 * The row that heads the card, by what the call is doing rather than by how it ended.
 *
 * A call in flight keeps the dispatch mark rather than a spinner: an async spawn returns at once, so
 * "running" means delegated rather than blocking. A call that succeeded takes the done mark, and any
 * other state is drawn as that state.
 */
function header(state: ViewStatus, ...meta: (string | undefined)[]): StatusRowView {
	const entries = meta.filter((entry): entry is string => entry !== undefined).map(entry => [span(entry)]);
	const mark: Pick<StatusRowView, "status" | "emblem"> =
		state === "running"
			? { emblem: "tool.task" }
			: state === "success"
				? { emblem: "status.done" }
				: { status: state };
	return { kind: "statusRow", ...mark, title: "Task", ...(entries.length === 0 ? {} : { meta: entries }) };
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
		appendMarkdownBriefSections(sections, args);
		const rows = callRows(args);
		if (rows.length > 0) sections.push(treeSection(rows));
	}
	const isolated = "isolated" in args && args.isolated === true;
	return {
		kind: "framedBlock",
		header: header("running", agentHeaderLabel(args), isolated ? "isolated" : undefined),
		state: "pending",
		sections,
	};
}

/** The card once the call has spawned something, live or settled. */
function renderResult(result: TaskViewResult, context: ToolViewContext, rawArgs?: unknown): FramedBlockView {
	const args = rawArgs as TaskParams | undefined;
	const fallbackText = extractResultText(result.content);
	const details = result.details;
	if (!details) return detaillessCard(result, args, fallbackText);

	const card: CardOptions = {
		expanded: context.expanded === true,
		showResolvedModelBadge: context.showResolvedModel === true,
	};
	const frozen = context.frozen === true;
	const settled = details.results !== undefined && details.results.length > 0;
	const tally = tallyResults(settled ? details.results : []);
	const refused = details.warning !== undefined;
	const state = cardState(context.partial === true, refused, tally.counts);
	// The header's fact is the spawn count alone; each row carries its own agent badge, so a joined
	// list of types here would repeat them. Before anything spawns it falls back to the call's type.
	const agentCount = settled ? details.results.length : (details.progress?.length ?? 0);
	const headerRow = header(state, agentCount > 0 ? formatCount("agent", agentCount) : agentHeaderLabel(args));
	const rows = settled
		? settledAgentRows(details, card, frozen, tally)
		: liveAgentRows(details.progress ?? [], card, frozen);
	const sections: ViewSection[] = [];
	appendMarkdownBriefSections(sections, args);
	if (rows.length === 0) {
		const text = fallbackText.trim() ? replaceTabs(shortenEmbeddedPaths(fallbackText)) : "No results";
		sections.push({ separator: true, lines: [[span(text, refused ? "warning" : "dim")]], clip: true });
	} else {
		rows.push(...notificationRows(fallbackText));
		sections.push(treeSection(rows));
	}
	return { kind: "framedBlock", header: headerRow, state, sections };
}

/** A result with no details: the brief, then the text the tool returned, drawn as an error when it is one. */
function detaillessCard(result: TaskViewResult, args: TaskParams | undefined, text: string): FramedBlockView {
	const state: ViewStatus = result.isError === true ? "error" : "success";
	const sections: ViewSection[] = [];
	appendMarkdownBriefSections(sections, args);
	if (text) {
		sections.push({
			separator: true,
			lines: [[span(replaceTabs(shortenEmbeddedPaths(text)), state === "error" ? "error" : "dim")]],
			clip: true,
		});
	}
	return { kind: "framedBlock", header: header(state, agentHeaderLabel(args)), state, sections };
}

/** How a batch's finished agents settled, and the requests they spent between them. */
interface ResultTally {
	readonly counts: Record<AgentOutcomeKind, number>;
	readonly requests: number;
}

/**
 * One pass over the results derives the header's state and the footer's totals both: the card
 * repaints on every frame while agents are live.
 */
function tallyResults(results: readonly SingleResult[]): ResultTally {
	const counts: Record<AgentOutcomeKind, number> = { completed: 0, "merge-failed": 0, failed: 0, aborted: 0 };
	let requests = 0;
	for (const result of results) {
		requests += result.requests ?? 0;
		counts[classifyAgentOutcome(result).kind]++;
	}
	return { counts, requests };
}

/** The card's state: running while partial, then a refused spawn, a failed agent, a failed merge, else success. */
function cardState(partial: boolean, refused: boolean, counts: Record<AgentOutcomeKind, number>): ViewStatus {
	if (partial) return "running";
	if (refused) return "warning";
	if (counts.aborted > 0 || counts.failed > 0) return "error";
	return counts["merge-failed"] > 0 ? "warning" : "success";
}

/**
 * A call's live agents. Folding from the top keeps the live edge: finished rows sort first, so a
 * collapsed card stands one summary row in for them and keeps the agents still working.
 */
function liveAgentRows(progress: readonly AgentProgress[], card: CardOptions, frozen: boolean): TaskRow[] {
	const ordered = orderProgressForDisplay(progress);
	const visible = card.expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
	const rows: TaskRow[] = [];
	if (visible.length < ordered.length) {
		rows.push(openRow(TOP, hiddenProgressSpans(ordered.slice(0, ordered.length - visible.length))));
	}
	for (const agent of visible) appendProgress(rows, agent, TOP, card, frozen, undefined, 0);
	return rows;
}

/**
 * A call's finished agents, then the batch's totals.
 *
 * A mixed call's async spawn never lands in `results`, since its payload arrives through a job, so
 * its row stays beside the finalized ones: live while it runs, settled once it lands.
 */
function settledAgentRows(details: TaskToolDetails, card: CardOptions, frozen: boolean, tally: ResultTally): TaskRow[] {
	const ordered = orderResultsForDisplay(details.results);
	const visible = card.expanded ? ordered : selectCollapsedResults(ordered);
	const rows: TaskRow[] = [];
	for (const result of visible) appendResult(rows, result, TOP, card, undefined, 0);
	if (visible.length < ordered.length) {
		rows.push(openRow(TOP, [span(formatMoreItems(ordered.length - visible.length, "agent"), "dim")]));
	}
	if (details.progress) {
		const finished = new Set(details.results.map(result => result.id));
		for (const agent of orderProgressForDisplay(details.progress.filter(entry => !finished.has(entry.id)))) {
			appendProgress(rows, agent, TOP, card, frozen, undefined, 0);
		}
	}
	rows.push(openRow(TOP, totalsSpans(tally, details.totalDurationMs)));
	return rows;
}

/** The batch's totals between brackets: how its agents settled, the requests they spent, and its runtime. */
function totalsSpans({ counts, requests }: ResultTally, durationMs: number): ViewSpan[] {
	const parts: ViewSpan[] = [];
	if (counts.aborted > 0) pushDotSpan(parts, `${counts.aborted} aborted`, "error");
	if (counts.completed > 0) pushDotSpan(parts, `${counts.completed} succeeded`, "success");
	if (counts["merge-failed"] > 0) pushDotSpan(parts, `${counts["merge-failed"]} merge failed`, "warning");
	if (counts.failed > 0) pushDotSpan(parts, `${counts.failed} failed`, "error");
	if (requests > 0) pushDotSpan(parts, `${formatNumber(requests)} req`, "dim");
	pushDotSpan(parts, formatDuration(durationMs), "dim");
	return [
		{ text: "", symbol: "format.bracketLeft", tone: "dim" },
		...parts,
		{ text: "", symbol: "format.bracketRight", tone: "dim" },
	];
}

/**
 * A summary the tool wrote for the model — the patches it applied, a notification — is the one part
 * of the text result the card repeats, because nothing above it says whether the work landed.
 */
function notificationRows(text: string): TaskRow[] {
	const lines = text.split("\n");
	const markerIndex = lines.findIndex(
		line =>
			line.includes("<system-notification>") ||
			line.startsWith("Applied patches:") ||
			line.startsWith("No changes to apply."),
	);
	if (markerIndex < 0) return [];
	const rows: TaskRow[] = [];
	for (const line of lines.slice(markerIndex)) {
		if (line.trim()) rows.push(openRow(TOP, [span(replaceTabs(shortenEmbeddedPaths(line)), "dim")]));
	}
	return rows;
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
