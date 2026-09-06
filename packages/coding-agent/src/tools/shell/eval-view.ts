/**
 * What an eval card shows, for any host.
 *
 * One card per call, whatever the call ran: a head row naming the kernel, then one group per cell
 * carrying its source, its output, the helper calls the cell made and the subagents it spawned, and
 * a closing group for the values it displayed and any notice about them. A cell is a GROUP rather
 * than a card of its own, which is the one shape change this conversion makes: a view is one card,
 * and a terminal drew three cells as three railed boxes.
 *
 * Nothing here knows what a row looks like. The source is stated as source, so the host highlights
 * it and numbers it; the streamed edge of a long cell is stated as a window onto the end, so the
 * host — the only party that knows how many rows a line wraps to and how many rows it has — decides
 * what to drop; and the helper calls are stated as a list, so the host marks the items its own way.
 */

import { formatContextUsage, formatCount, formatNumber, isRecord } from "@veyyon/utils";
import type {
	FramedBlockView,
	HeadedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewStatus,
	ViewTone,
} from "@veyyon/view";
// The slot leaf, not the 95-module store: this file reads one setting, it does not fill them.
import { settings } from "../../config/settings-instance";
import type { EvalCellResult, EvalLanguage, EvalStatusEvent, EvalToolDetails } from "../../eval/types";
import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	jsonTreeViewLines,
} from "../core/json-tree-view";
import { stripOutputNotice } from "../core/output-meta";
// The words a truncation is named by, from the leaf that owns them rather than from the styled
// helper beside it: a view states the sentence and never the colour it is drawn in.
import { formatTruncationMetaNotice } from "../core/output-notice";
import {
	collapseProgressRuns,
	Ellipsis,
	formatDuration,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	truncateToWidth,
} from "../core/render-utils";
/** The rows a collapsed cell's output may spend, which a host may narrow to its own window. */
export const EVAL_DEFAULT_PREVIEW_LINES = 10;

/**
 * The ceiling the EXPANDED arm of a cell keeps, so opening a card is a bigger window and never no
 * window. The number is the one every code cell in this tree already spends on an expanded body.
 */
const EXPANDED_MAX_LINES = 200;

/** The columns one status-event detail row may spend. */
const DETAIL_MAX_WIDTH = 80;
/** The columns a subagent's preview, tool argument or intent may spend. */
const AGENT_DETAIL_MAX_WIDTH = 48;
/** The columns a resolved model name may spend. */
const MODEL_MAX_WIDTH = 30;
/** The items one expanded status event lists before it says how many are left. */
const DETAIL_ITEM_LIMIT = 5;
/** The items an `env` event lists, which is a longer set worth reading whole. */
const ENV_ITEM_LIMIT = 10;
/** The lines one expanded status event previews. */
const DETAIL_PREVIEW_LINES = 3;
/** The status events a collapsed card keeps, newest last. */
const STATUS_EVENTS_COLLAPSED = 3;
/** The two columns a detail row sits in, under the event that owns it. */
const DETAIL_INDENT = "  ";

/** The cell of a call, as the arguments carry it. */
export interface EvalRenderCellArg {
	language?: string;
	code?: string;
	title?: string;
}

/** The arguments an eval card reads, in both the one-cell and the many-cell shape. */
export interface EvalRenderArgs {
	language?: string;
	code?: string;
	title?: string;
	cells?: EvalRenderCellArg[];
	__partialJson?: string;
}

/** The result an eval card reads: the text the tool returned, and the cells it carries. */
export interface EvalViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: EvalToolDetails;
	isError?: boolean;
}

/** The cell of a call, normalized. */
interface EvalViewCell {
	language: EvalLanguage;
	code: string;
	title?: string;
}

/** The language name a host highlights by, which is not the kernel's own id for it. */
function highlightLanguage(language: EvalLanguage | undefined): string {
	if (language === "js") return "javascript";
	if (language === "ruby") return "ruby";
	if (language === "julia") return "julia";
	return "python";
}

function normalizeLanguage(value: string | undefined): EvalLanguage {
	if (value === "js") return "js";
	if (value === "rb" || value === "ruby") return "ruby";
	if (value === "jl" || value === "julia") return "julia";
	return "python";
}

/** The cells a call asked for, from either shape of the arguments. */
function callCells(args: EvalRenderArgs | undefined): EvalViewCell[] {
	if (!args) return [];
	const raw = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : [];
	const cells: EvalViewCell[] = [];
	for (const cell of raw) {
		if (!cell || typeof cell !== "object") continue;
		cells.push({
			language: normalizeLanguage(typeof cell.language === "string" ? cell.language : undefined),
			code: typeof cell.code === "string" ? cell.code : "",
			title: typeof cell.title === "string" ? cell.title : undefined,
		});
	}
	return cells;
}

/**
 * A cell's own rows, split and cleaned.
 *
 * A carriage return inside a line is a cursor return: a progress bar overwrites its row, so only the
 * last segment was ever on screen and only it is shown.
 */
function textRows(text: string): string[] {
	return text.split(/\r?\n/).map(line => {
		const at = line.lastIndexOf("\r");
		return replaceTabs(shortenEmbeddedPaths(at < 0 ? line : line.slice(at + 1)));
	});
}

/** What a card kept back, or nothing when it kept back nothing. */
function heldBack(count: number, one: string, many: string): ViewHiddenCount | undefined {
	if (count <= 0) return undefined;
	return { count, noun: { one, many }, revealable: true };
}

/**
 * The state a cell reports, as the mark a host draws for it.
 *
 * `complete` is `done` rather than `success`: a settled cell is a cell that finished, which is the
 * mark every code cell in this tree has drawn for one, and `success` is the mark a card that ran a
 * check draws.
 */
function cellStatus(status: EvalCellResult["status"]): ViewStatus {
	switch (status) {
		case "complete":
			return "done";
		case "error":
			return "error";
		case "running":
			return "running";
		case "pending":
			return "pending";
	}
}

/** The cell states a card reports, worst first, so the header states the worst of them. */
const WORST_FIRST: readonly EvalCellResult["status"][] = ["error", "running", "pending"];

/** The state a subagent reports, as the mark a host draws for it. */
function agentStatus(value: unknown): ViewStatus {
	switch (value) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "aborted":
			return "aborted";
		case "pending":
			return "pending";
		default:
			return "running";
	}
}

function eventText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The source of one cell, as a section the host colours and numbers.
 *
 * A collapsed card states the whole source and says the END is what matters, because a cell still
 * being written grows at the bottom and the host is the one that knows how many rows it has for it.
 * An expanded card keeps a ceiling of its own -- opening a card is a bigger window, never no window
 * -- so there the tool cuts and says how much it cut.
 */
function codeSection(cell: EvalViewCell | EvalCellResult, label: string | undefined, expanded: boolean): ViewSection {
	const language = highlightLanguage(cell.language);
	const rows = textRows(cell.code ?? "");
	if (!expanded) {
		return {
			...(label === undefined ? {} : { label }),
			lines: rows.map(row => [{ text: row }]),
			code: { language },
			tail: {},
		};
	}
	const shown = rows.slice(0, EXPANDED_MAX_LINES);
	const hidden = heldBack(rows.length - shown.length, "line", "lines");
	return {
		...(label === undefined ? {} : { label }),
		lines: shown.map(row => [{ text: row }]),
		code: { language },
		...(hidden === undefined ? {} : { hidden }),
	};
}

/**
 * The output of one cell.
 *
 * A cell whose output is a document is stated as one, so the host formats it; anything else is the
 * program's own text, toned by whether the cell failed. A run of same-shape progress lines is
 * condensed before the window is measured, so a wall of `Compiling …` cannot spend the whole window
 * and push the interesting line out of it.
 */
function outputSection(cell: EvalCellResult, expanded: boolean): ViewSection | undefined {
	if (!cell.output?.trim()) return undefined;
	const label = "Output";
	if (cell.hasMarkdown && cell.status !== "error") {
		return {
			label,
			// The document keeps the document theme's own colours, as every card that states one does:
			// main toned an output row it found unstyled, which dulled a heading it had styled itself.
			lines: [[{ text: cell.output }]],
			markdown: true,
			...(expanded ? {} : { tail: { max: EVAL_DEFAULT_PREVIEW_LINES } }),
		};
	}
	const tone: ViewTone = cell.status === "error" ? "error" : "output";
	if (expanded) {
		const rows = textRows(cell.output);
		const shown = rows.slice(0, EXPANDED_MAX_LINES);
		const hidden = heldBack(rows.length - shown.length, "line", "lines");
		return {
			label,
			lines: shown.map(row => [{ text: row, tone }]),
			...(hidden === undefined ? {} : { hidden }),
		};
	}
	const lines = collapseProgressRuns(textRows(cell.output)).map(row =>
		row.hidden === 0
			? [{ text: row.text, tone }]
			: [
					{ text: row.text, tone },
					{ text: ` … +${row.hidden} earlier`, tone: "dim" as ViewTone },
				],
	);
	return { label, lines, tail: { max: EVAL_DEFAULT_PREVIEW_LINES } };
}

/** The mark a helper call carries, which is what kind of thing it touched. */
function opSymbol(op: string): string {
	switch (op) {
		case "ls":
		case "cd":
		case "pwd":
		case "mkdir":
			return "icon.folder";
		case "git_status":
		case "git_diff":
		case "git_log":
		case "git_show":
		case "git_branch":
		case "git_file_at":
		case "git_has_changes":
			return "icon.git";
		case "run":
		case "sh":
		case "env":
		case "batch":
		case "completion":
		case "log":
		case "phase":
			return "icon.package";
		default:
			return "icon.file";
	}
}

/** What one helper call did, in the words its row carries after the op. */
function describeEvent(op: string, data: Record<string, unknown>): string {
	const parts: string[] = [];
	switch (op) {
		case "read":
			parts.push(`${eventCount(data.chars ?? data.bytes)} chars`);
			if (data.path) parts.push(`from ${shortenPath(String(data.path))}`);
			break;
		case "write":
			parts.push(`${eventCount(data.chars ?? data.bytes)} chars`);
			if (data.path) parts.push(`to ${shortenPath(String(data.path))}`);
			break;
		case "cat":
			parts.push(formatCount("file", eventCount(data.files)));
			parts.push(`${eventCount(data.chars)} chars`);
			break;
		case "ls":
			parts.push(`${eventCount(data.count)} ${eventCount(data.count) === 1 ? "entry" : "entries"}`);
			break;
		case "env":
			if (data.action === "set") {
				parts.push(`set ${String(data.key)}=${truncateToWidth(String(data.value ?? ""), MODEL_MAX_WIDTH)}`);
			} else if (data.action === "get") {
				parts.push(`${String(data.key)}=${truncateToWidth(String(data.value ?? ""), MODEL_MAX_WIDTH)}`);
			} else {
				parts.push(formatCount("variable", eventCount(data.count)));
			}
			break;
		case "git_status": {
			if (data.clean) {
				parts.push("clean");
			} else {
				const state: string[] = [];
				if (data.staged) state.push(`${String(data.staged)} staged`);
				if (data.modified) state.push(`${String(data.modified)} modified`);
				if (data.untracked) state.push(`${String(data.untracked)} untracked`);
				parts.push(state.join(", ") || "unknown");
			}
			if (data.branch) parts.push(`on ${String(data.branch)}`);
			break;
		}
		case "git_log":
			parts.push(formatCount("commit", eventCount(data.commits)));
			break;
		case "git_diff":
			parts.push(formatCount("line", eventCount(data.lines)));
			if (data.staged) parts.push("(staged)");
			break;
		case "batch":
			parts.push(`${formatCount("file", eventCount(data.files))} processed`);
			break;
		case "completion":
			if (data.model) parts.push(String(data.model));
			if (data.tier && data.tier !== data.model) parts.push(`(${String(data.tier)})`);
			parts.push(`${eventCount(data.chars)} chars`);
			break;
		case "wc":
			parts.push(`${eventCount(data.lines)}L ${eventCount(data.words)}W ${eventCount(data.chars)}C`);
			break;
		case "cd":
		case "pwd":
		case "mkdir":
		case "touch":
			if (data.path) parts.push(shortenPath(String(data.path)));
			break;
		case "log":
			parts.push(String(data.message ?? ""));
			break;
		case "phase":
			parts.push(String(data.title ?? ""));
			break;
		default:
			if (data.count !== undefined) parts.push(String(data.count));
			if (data.path) parts.push(shortenPath(String(data.path)));
	}
	return parts.join(" · ");
}

/** One helper call's row: what it was, and what it did. */
function eventLine(event: EvalStatusEvent): ViewLine {
	const { op, ...data } = event;
	const mark: ViewSpan = { text: "", symbol: opSymbol(op), tone: "muted" };
	if (data.error) {
		return [
			mark,
			{ text: " " },
			{ text: op, tone: "warning" },
			{ text: ": " },
			{ text: String(data.error), tone: "dim" },
		];
	}
	const description = describeEvent(op, data);
	return description === ""
		? [mark, { text: " " }, { text: op, tone: "muted" }]
		: [mark, { text: " " }, { text: op, tone: "muted" }, { text: " " }, { text: description, tone: "dim" }];
}

/** The rows one helper call adds when the card is open: what it listed, or what it read. */
function eventDetailLines(event: EvalStatusEvent): ViewLine[] {
	const { op, ...data } = event;
	const lines: ViewLine[] = [];
	const items = (values: unknown, format: (value: unknown) => string, limit = DETAIL_ITEM_LIMIT): void => {
		const list = Array.isArray(values) ? values : [];
		for (const value of list.slice(0, limit)) {
			lines.push([{ text: DETAIL_INDENT }, { text: format(value), tone: "dim" }]);
		}
		if (list.length > limit) {
			lines.push([{ text: DETAIL_INDENT }, { text: `… ${list.length - limit} more`, tone: "dim" }]);
		}
	};
	const preview = (text: string): void => {
		const rows = textRows(text);
		for (const row of rows.slice(0, DETAIL_PREVIEW_LINES)) {
			lines.push([
				{ text: DETAIL_INDENT },
				{ text: truncateToWidth(row, DETAIL_MAX_WIDTH, Ellipsis.Unicode), tone: "output" },
			]);
		}
		if (rows.length > DETAIL_PREVIEW_LINES) {
			lines.push([
				{ text: DETAIL_INDENT },
				{ text: `… ${formatCount("more line", rows.length - DETAIL_PREVIEW_LINES)}`, tone: "dim" },
			]);
		}
	};
	switch (op) {
		case "ls":
			if (data.items) items(data.items, value => String(value));
			break;
		case "env":
			if (data.keys) items(data.keys, value => String(value), ENV_ITEM_LIMIT);
			break;
		case "git_log":
			if (data.entries) {
				items(data.entries, value => {
					const entry = isRecord(value) ? value : {};
					return `${String(entry.sha ?? "")} ${truncateToWidth(String(entry.subject ?? ""), 50, Ellipsis.Unicode)}`;
				});
			}
			break;
		case "git_status":
			if (data.files) items(data.files, value => String(value));
			break;
		case "git_branch":
			if (data.branches) items(data.branches, value => String(value));
			break;
		case "read":
		case "cat":
		case "head":
		case "tail":
		case "git_diff":
		case "sh":
			if (data.preview) preview(String(data.preview));
			break;
	}
	return lines;
}

/**
 * The helper calls a cell made, as a list the host marks.
 *
 * The newest calls are what a `log()` loop is reporting, so a collapsed card keeps the END of the
 * run and states how many earlier calls it dropped. An expanded card lists every call and, under
 * each, what it listed or read.
 */
function statusSection(events: readonly EvalStatusEvent[], expanded: boolean): ViewSection | undefined {
	if (events.length === 0) return undefined;
	if (expanded) {
		return { label: "Status", lines: events.flatMap(event => [eventLine(event), ...eventDetailLines(event)]) };
	}
	const shown = events.slice(Math.max(0, events.length - STATUS_EVENTS_COLLAPSED));
	const hidden = heldBack(events.length - shown.length, "call", "calls");
	return {
		label: "Status",
		lines: shown.map(event => eventLine(event)),
		list: true,
		...(hidden === undefined ? {} : { hidden }),
	};
}

/** The facts a subagent's row carries after its id: how much it has done, and what it cost. */
function agentFacts(event: EvalStatusEvent): ViewSpan[] {
	const spans: ViewSpan[] = [];
	const toolCount = eventCount(event.toolCount);
	if (toolCount > 0) spans.push({ text: `${formatNumber(toolCount)} tools`, tone: "dim" });
	const contextTokens = eventCount(event.contextTokens);
	if (contextTokens > 0) {
		spans.push({ text: formatContextUsage(contextTokens, eventCount(event.contextWindow)), tone: "dim" });
	}
	const cost = eventCount(event.cost);
	if (cost > 0) spans.push({ text: `$${cost.toFixed(2)}`, tone: "info" });
	const model = eventText(event.model);
	if (model !== undefined && settings.get("subagent.showResolvedModelBadge")) {
		spans.push({ text: truncateToWidth(replaceTabs(model), MODEL_MAX_WIDTH, Ellipsis.Unicode), tone: "dim" });
	}
	const status = agentStatus(event.status);
	if (status === "done" || status === "error" || status === "aborted") {
		const durationMs = eventCount(event.durationMs);
		if (durationMs > 0) spans.push({ text: formatDuration(durationMs), tone: "dim" });
	}
	return spans;
}

/**
 * The subagents a cell spawned, as a list of what each one is doing.
 *
 * A running agent's row is followed by the tool it is in and the intent it stated, which is the one
 * thing a reader watching a spawned run wants; a settled agent's row is what it cost.
 */
function agentSection(events: readonly EvalStatusEvent[]): ViewSection | undefined {
	if (events.length === 0) return undefined;
	const lines: ViewLine[] = [];
	for (const event of events) {
		const status = agentStatus(event.status);
		const id = eventText(event.id) ?? "agent";
		const line: ViewSpan[] = [{ text: "", status }, { text: " " }, { text: id, tone: "accent", bold: true }];
		if (status === "error" || status === "aborted") {
			line.push({ text: " " }, { text: status === "error" ? "failed" : "aborted", badge: true, tone: "error" });
		}
		const currentTool = eventText(event.currentTool);
		const lastIntent = eventText(event.lastIntent);
		if (status === "running" && currentTool === undefined && lastIntent === undefined) {
			const preview = eventText(event.taskPreview);
			if (preview !== undefined) {
				line.push(
					{ text: " " },
					{ text: truncateToWidth(replaceTabs(preview), AGENT_DETAIL_MAX_WIDTH, Ellipsis.Unicode), tone: "muted" },
				);
			}
		}
		for (const fact of agentFacts(event)) line.push({ text: " " }, fact);
		lines.push(line);
		if (status !== "running") continue;
		if (currentTool !== undefined) {
			const detail = lastIntent ?? eventText(event.currentToolArgs);
			lines.push([
				{ text: DETAIL_INDENT },
				{ text: currentTool, tone: "muted" },
				...(detail === undefined
					? []
					: [
							{ text: ": " },
							{
								text: truncateToWidth(replaceTabs(detail), AGENT_DETAIL_MAX_WIDTH, Ellipsis.Unicode),
								tone: "dim" as ViewTone,
							},
						]),
			]);
		} else if (lastIntent !== undefined) {
			lines.push([
				{ text: DETAIL_INDENT },
				{ text: truncateToWidth(replaceTabs(lastIntent), AGENT_DETAIL_MAX_WIDTH, Ellipsis.Unicode), tone: "dim" },
			]);
		}
	}
	// A subagent tree is one row per agent plus what it is doing, so it is not a list the host marks:
	// an item here is two lines and a list states one.
	return { label: "Agents", lines };
}

/** The values a cell displayed, and the notices that came with them. */
function trailingSection(details: EvalToolDetails | undefined, expanded: boolean): ViewSection | undefined {
	const lines: ViewLine[] = [];
	const outputs = details?.jsonOutputs ?? [];
	const bounds = {
		maxDepth: expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED,
		maxLines: expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED,
		maxScalarLen: expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED,
	};
	const labelled = outputs.length > 1;
	for (const [index, value] of outputs.entries()) {
		const tree = jsonTreeViewLines(value, bounds);
		if (labelled) lines.push([{ text: `display[${index + 1}]`, tone: "dim" }]);
		lines.push(...tree.lines);
		if (tree.truncated) lines.push([{ text: "…", tone: "dim" }]);
	}
	if (details?.notice) lines.push([{ text: details.notice, tone: "dim" }]);
	const truncation = details?.meta?.truncation;
	if (truncation !== undefined) lines.push([{ text: formatTruncationMetaNotice(truncation), tone: "warning" }]);
	return lines.length === 0 ? undefined : { lines };
}

/** The row that heads the card: the kernel it ran in, and how the run ended. */
function header(
	cells: readonly EvalCellResult[] | readonly EvalViewCell[],
	status: ViewStatus,
	durationMs: number | undefined,
): StatusRowView {
	const first = cells[0];
	const many = cells.length > 1;
	const title = many
		? `${cells.length} cells`
		: ((first as EvalCellResult | EvalViewCell | undefined)?.title ?? "Code");
	const language = highlightLanguage(first?.language);
	return {
		kind: "statusRow",
		status,
		title,
		titleTone: "title",
		language,
		...(durationMs === undefined || durationMs <= 0
			? {}
			: { meta: [[{ text: `(${formatDuration(durationMs)})`, tone: "dim" as ViewTone }]] }),
	};
}

/** The state the whole card reports, which is the worst thing any cell reported. */
function overallStatus(cells: readonly EvalCellResult[], partial: boolean): ViewStatus {
	for (const status of WORST_FIRST) {
		if (cells.some(cell => cell.status === status)) return cellStatus(status);
	}
	// Nothing in the card is still going, so a card the HOST is still streaming is what remains.
	return partial ? "running" : cellStatus("complete");
}

export const evalToolView: Required<ToolViewRenderer<EvalRenderArgs, EvalViewResult>> = {
	renderCall(args: EvalRenderArgs, context: ToolViewContext): ToolView {
		const cells = callCells(args);
		// A call whose code has not arrived yet is a prompt and nothing else: there is no source to
		// show, so the row says the kernel is waiting for one.
		if (cells.length === 0) {
			return { kind: "statusRow", status: "pending", title: ">>> …" };
		}
		const status: ViewStatus = context.frame === undefined ? "pending" : "running";
		return {
			kind: "framedBlock",
			header: header(cells, status, undefined),
			state: status,
			sections: cells.map((cell, index) =>
				codeSection(
					cell,
					cells.length > 1
						? `[${index + 1}/${cells.length}]${cell.title === undefined ? "" : ` ${cell.title}`}`
						: undefined,
					context.expanded,
				),
			),
		} satisfies FramedBlockView;
	},

	renderResult(result: EvalViewResult, context: ToolViewContext): ToolView {
		const details = result.details;
		const expanded = context.expanded;
		const cells = details?.cells ?? [];
		const trailing = trailingSection(details, expanded);

		if (cells.length > 0) {
			const sections: ViewSection[] = [];
			for (const [index, cell] of cells.entries()) {
				const label =
					cells.length > 1
						? `[${index + 1}/${cells.length}]${cell.title === undefined ? "" : ` ${cell.title}`}`
						: undefined;
				sections.push(codeSection(cell, label, expanded));
				const output = outputSection(cell, expanded);
				if (output !== undefined) sections.push(output);
				const events = cell.statusEvents ?? [];
				const agents = events.filter(event => event.op === "agent");
				const helpers = agents.length > 0 ? events.filter(event => event.op !== "agent") : events;
				const status = statusSection(helpers, expanded);
				if (status !== undefined) sections.push(status);
				const agentRows = agentSection(agents);
				if (agentRows !== undefined) sections.push(agentRows);
			}
			if (trailing !== undefined) sections.push(trailing);
			const durationMs = cells.reduce((total, cell) => total + (cell.durationMs ?? 0), 0);
			return {
				kind: "framedBlock",
				header: header(cells, overallStatus(cells, context.partial === true), durationMs),
				state: overallStatus(cells, context.partial === true),
				sections,
			} satisfies FramedBlockView;
		}

		// No cell ran, so there is no card to head: what the tool returned is the whole of it, which
		// is what a kernel that failed before it started, and a replayed transcript, both carry.
		const text = stripOutputNotice(
			(result.content?.find(part => part.type === "text")?.text ?? "").trimEnd(),
			details?.meta,
		).trimEnd();
		const lines: ViewLine[] = [];
		if (text !== "") {
			// A run of same-shape progress lines is condensed before the host measures its window, for
			// the reason a cell's output is: a wall of `Compiling …` must not spend the whole window.
			const rows = expanded
				? textRows(text).map(row => [{ text: row, tone: "output" as ViewTone }])
				: collapseProgressRuns(textRows(text)).map(row =>
						row.hidden === 0
							? [{ text: row.text, tone: "output" as ViewTone }]
							: [
									{ text: row.text, tone: "output" as ViewTone },
									{ text: ` … +${row.hidden} earlier`, tone: "dim" as ViewTone },
								],
					);
			lines.push(...rows);
		}
		const events = details?.statusEvents ?? [];
		if (events.length > 0) {
			lines.push([{ text: "Status", tone: "dim" }]);
			const shown = expanded ? events : events.slice(Math.max(0, events.length - STATUS_EVENTS_COLLAPSED));
			const earlier = events.length - shown.length;
			if (earlier > 0) lines.push([{ text: `… ${earlier} earlier`, tone: "dim" }]);
			for (const event of shown) {
				lines.push(eventLine(event));
				if (expanded) lines.push(...eventDetailLines(event));
			}
		}
		if (trailing !== undefined) lines.push(...trailing.lines);
		return {
			kind: "headedBlock",
			lines,
			...(expanded || text === "" ? {} : { tail: { max: EVAL_DEFAULT_PREVIEW_LINES } }),
		} satisfies HeadedBlockView;
	},
};
