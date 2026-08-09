/**
 * Shared utilities and constants for tool renderers.
 *
 * Provides consistent formatting, truncation, and display patterns across all
 * tool renderers to ensure a unified TUI experience.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallContext } from "@veyyon/agent-core";
import type { Ellipsis } from "@veyyon/natives";
import type { Component } from "@veyyon/tui";
import { getKeybindings, replaceTabs, truncateToWidth } from "@veyyon/tui";
// Owners, not the `@veyyon/utils` barrel: 3 modules against 74.
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { formatCount, pluralize } from "@veyyon/utils/format";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { formatKeyHints, type KeyId } from "../config/keybindings";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../config/settings-instance";
import type { Theme } from "../modes/theme/theme";
import { Hasher } from "../tui/utils";
import { formatDimensionNote, type ResizedImage } from "../utils/image-resize";

export { Ellipsis } from "@veyyon/natives";
export { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@veyyon/tui";

// =============================================================================
// Standardized Display Constants
// =============================================================================

/** Resolve inline image dimension caps from settings and viewport. */
export function resolveImageOptions(): { maxWidthCells: number; maxHeightCells?: number } {
	const maxWidthCells = settings.get("tui.maxInlineImageColumns");
	const rowSetting = Math.max(0, settings.get("tui.maxInlineImageRows"));
	const viewportRows = process.stdout.rows;
	const viewportFraction = viewportRows ? Math.floor(viewportRows * 0.6) : 0;
	let maxHeightCells: number | undefined;
	if (rowSetting === 0) {
		// No explicit cap — use viewport fraction as safety bound
		maxHeightCells = viewportFraction || undefined;
	} else if (viewportFraction > 0) {
		maxHeightCells = Math.min(rowSetting, viewportFraction);
	} else {
		// Viewport size unknown (transitional state) — honor explicit setting
		maxHeightCells = rowSetting;
	}
	return { maxWidthCells, maxHeightCells };
}

/** Preview limits for collapsed/expanded views */
export const PREVIEW_LIMITS = {
	/** Lines shown in collapsed view */
	COLLAPSED_LINES: 3,
	/** Lines shown in expanded view */
	EXPANDED_LINES: 12,
	/** Items (files, results) shown in collapsed view */
	COLLAPSED_ITEMS: 8,
	/** Output preview lines in collapsed view */
	OUTPUT_COLLAPSED: 3,
	/** Output preview lines in expanded view */
	OUTPUT_EXPANDED: 10,
	/** Max hunks shown when collapsed (edit tool) */
	DIFF_COLLAPSED_HUNKS: 8,
	/** Max diff lines shown when collapsed (edit tool) */
	DIFF_COLLAPSED_LINES: 40,
} as const;

/** Default number of terminal output rows shown before expansion. */
export const DEFAULT_TERMINAL_PREVIEW_LINES = 10;

/** Truncation lengths for different content types */
export const TRUNCATE_LENGTHS = {
	/** Short titles, labels */
	TITLE: 60,
	/** Medium-length content (messages, previews) */
	CONTENT: 80,
	/** Longer content (code, explanations) */
	LONG: 100,
	/** Full line content */
	LINE: 110,
	/** Very short (task previews, badges) */
	SHORT: 40,
	/** Status-line chips (session name in the footline) — the footline shares
	 *  one row with model, mode, path, git, and the context bar, so a chip may
	 *  never dominate it */
	CHIP: 24,
	/** Idle recap status line (~40-word LLM reply) */
	RECAP: 280,
} as const;

/** Keybinding action that toggles tool-output expansion. */
const EXPAND_ACTION = "app.tools.expand";
/** Fallback key when no binding is resolvable (e.g. outside an interactive session). */
const DEFAULT_EXPAND_KEY: KeyId = "ctrl+o";

/** Human-readable key currently bound to tool-output expansion, e.g. `Ctrl+O`. */
export function expandKeyHint(): string {
	const keys = getKeybindings().getKeys(EXPAND_ACTION);
	return formatKeyHints(keys.length > 0 ? keys : [DEFAULT_EXPAND_KEY]);
}

// =============================================================================
// Text Truncation Utilities
// =============================================================================

/**
 * Get first N lines of text as preview, with each line truncated.
 */
export function getPreviewLines(text: string, maxLines: number, maxLineLen: number, ellipsis?: Ellipsis): string[] {
	const lines = text.split("\n").filter(l => l.trim());
	return lines.slice(0, maxLines).map(l => truncateToWidth(l.trim(), maxLineLen, ellipsis));
}

/**
 * Collapse a possibly multi-line string into a single line, then truncate it to
 * `maxWidth` display cells. {@link truncateToWidth} alone caps width but
 * newlines are zero-width, so multi-line content (markdown briefs, tool args,
 * provider errors) would otherwise spill a single status row across several
 * visual lines. Whitespace runs collapse to one space, so tabs are handled too.
 */
export function previewLine(text: string, maxWidth: number, ellipsis?: Ellipsis): string {
	return truncateToWidth(collapseWhitespace(text), maxWidth, ellipsis);
}

// =============================================================================
// Progress-run Collapsing
// =============================================================================

/**
 * Minimum consecutive same-shape lines before a run is counted away. A run
 * collapses to one row plus a count, so anything shorter would trade a saved
 * row for a lost line.
 */
export const PROGRESS_RUN_MIN_LINES = 4;

/**
 * Leading tokens a run is never keyed on. A diagnostic is the anomaly the
 * collapsed preview exists to surface, so a wall of DISTINCT warnings keeps
 * every line even though the lines share a shape. Byte-identical neighbours
 * still collapse, diagnostic or not: repeating one line eight times says
 * nothing the count does not. Severity words only here, because the moment this
 * set learns what one specific tool prints, that knowledge belongs in the shell
 * minimizer (`crates/veyyon-shell/src/minimizer/`), which owns per-tool output
 * semantics for the sealed capture.
 */
const DIAGNOSTIC_LEAD_TOKENS: ReadonlySet<string> = new Set([
	"assertion",
	"err",
	"error",
	"errors",
	"exception",
	"fail",
	"failed",
	"failure",
	"failures",
	"fatal",
	"help",
	"hint",
	"note",
	"panic",
	"panicked",
	"traceback",
	"warn",
	"warning",
	"warnings",
]);

/** A collapsed preview row: one verbatim line plus the lines it stands in for. */
export interface CollapsedOutputRow {
	/** The run's newest line, verbatim. */
	readonly text: string;
	/** Lines this row stands in for beyond `text`; 0 when nothing was collapsed. */
	readonly hidden: number;
}

/**
 * Shape key consecutive lines are grouped by: the first whitespace-delimited
 * token with digit runs normalized, so `[1/47]` and `[2/47]` share a key and so
 * do `Compiling serde` and `Compiling tokio`. `undefined` means the line can
 * only extend a run of byte-identical neighbours.
 *
 * Three token shapes qualify, because any other leading token is content: a
 * Capitalized word (`Compiling`, `Downloaded`), a lowercase word ending in a
 * colon (`remote:`, `info:`), and a bracketed or hashed counter (`[#/#]`, `##`).
 * `ls -l` mode columns (`-rw-r--r--`, `drwxr-xr-x`) match none of the three, so
 * a directory listing is never counted away.
 *
 * Keyed on the line with its SGR escapes removed, because a real build writes
 * them: cargo emits `\x1b[1m\x1b[32m   Compiling\x1b[0m serde`, whose first
 * non-space token starts with the escape rather than with `Compiling`. Keying on
 * the raw bytes made every colored progress line unshaped, which is to say it
 * collapsed nothing outside a test fixture. The row still carries the ORIGINAL
 * line, colors intact.
 */
function progressRunKey(line: string): string | undefined {
	const bare = line.includes("\u001b") ? stripAnsi(line) : line;
	const token = /^\S+/.exec(bare.trim())?.[0];
	if (token === undefined) return undefined;
	if (DIAGNOSTIC_LEAD_TOKENS.has(token.replace(/:$/, "").toLowerCase())) return undefined;
	const shaped = /^[A-Z][A-Za-z]*:?$/.test(token) || /^[a-z]+:$/.test(token) || /^[[(#]/.test(token);
	return shaped ? token.replace(/\d+/g, "#") : undefined;
}

/**
 * Collapse runs of consecutive progress lines so a viewport-sized tail window is
 * spent on anomalies instead of on a build's `Compiling …` wall. Each run of
 * `minRun` or more same-shape lines becomes its newest line plus a count;
 * every other line survives verbatim, in order.
 *
 * Language-agnostic by construction (see `progressRunKey`): the shell minimizer
 * owns per-tool semantics, but it only ever sees a sealed capture, so a card
 * that is still streaming has to condense on shape alone.
 */
export function collapseProgressRuns(
	lines: readonly string[],
	minRun: number = PROGRESS_RUN_MIN_LINES,
): CollapsedOutputRow[] {
	const rows: CollapsedOutputRow[] = [];
	let index = 0;
	while (index < lines.length) {
		const first = lines[index]!;
		const key = progressRunKey(first);
		let end = index + 1;
		while (end < lines.length) {
			const next = lines[end]!;
			// A blank line never anchors a run: an empty row carries no text to keep,
			// so counting blanks away would leave a bare `+N earlier` marker.
			const extendsRun =
				next === first ? first.trim().length > 0 : key !== undefined && progressRunKey(next) === key;
			if (!extendsRun) break;
			end++;
		}
		const run = end - index;
		if (run >= minRun) {
			rows.push({ text: lines[end - 1]!, hidden: run - 1 });
		} else {
			for (let i = index; i < end; i++) rows.push({ text: lines[i]!, hidden: 0 });
		}
		index = end;
	}
	return rows;
}

/**
 * {@link collapseProgressRuns} themed for a tool card's collapsed output
 * section: the counted-away lines are named in `dim` so the count reads as
 * chrome rather than as output. `styleLine` owns per-line styling (a failed eval
 * cell paints its output in `error`), and defaults to tab-replaced tool output.
 */
export function renderCollapsedOutputLines(
	lines: readonly string[],
	theme: Theme,
	styleLine: (line: string) => string = line => theme.fg("toolOutput", replaceTabs(line)),
): string[] {
	return collapseProgressRuns(lines).map(row => {
		const text = styleLine(row.text);
		return row.hidden === 0 ? text : `${text}${theme.fg("dim", ` … +${row.hidden} earlier`)}`;
	});
}

// =============================================================================
// URL Utilities
// =============================================================================

/**
 * Extract domain from URL, stripping www. prefix.
 */
export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

// =============================================================================
// Formatting Utilities
// =============================================================================

export { formatAge, formatBytes, formatCount, formatDuration, pluralize } from "@veyyon/utils/format";
export type { ToolUIStatus } from "./tool-ui-status";
// The status glyph and its status union live in a leaf, so a status line does not have to import
// this module's 167. Re-exported because every existing caller asks this file for them.
export { formatStatusIcon } from "./tool-ui-status";

// =============================================================================
// Theme Helper Utilities
// =============================================================================

/**
 * Format the expand hint with proper theming.
 * Same fold dialect as settings/ModalShell: collapsed chevron + key, not a
 * third bracket grammar.
 * Returns empty string if already expanded or there is nothing more to show.
 */
export function formatExpandHint(theme: Theme, expanded?: boolean, hasMore?: boolean): string {
	if (expanded) return "";
	if (hasMore === false) return "";
	const chevron = theme.nav?.expand ?? "▸";
	return theme.fg("dim", `${chevron} ${expandKeyHint()} expand`);
}

/**
 * Format a badge like [done] or [failed] with brackets and color.
 */
export function formatBadge(label: string, color: ToolUIColor, theme: Theme): string {
	const left = theme.format.bracketLeft;
	const right = theme.format.bracketRight;
	return theme.fg(color, `${left}${label}${right}`);
}

/**
 * Build a "more items" suffix line for truncated lists.
 * Uses consistent wording pattern.
 */
export function formatMoreItems(remaining: number, itemType: string): string {
	const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
	return `… ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

/**
 * Collapsed command/code previews render a tail window sized from the live
 * viewport: terminal rows minus a reserve for the rest of the block (frame,
 * Output section, stats line) and the editor/status area below the
 * transcript. This keeps a volatile streaming block from growing past the
 * viewport and stranding its top, while letting tall terminals show more.
 */
const PREVIEW_WINDOW_RESERVED_ROWS = 20;
/** Floor so tiny or unknown viewports still show a useful window. */
const PREVIEW_WINDOW_MIN_LINES = 6;
/** Assumed viewport when rows are unknown (non-TTY, tests). */
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

/** Tail-window height for collapsed command/code previews. */
export function previewWindowRows(): number {
	const rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS;
	return Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS);
}

/**
 * Cap a pre-rendered command preview to a viewport-sized tail window: the end
 * of the command stays visible (it is the live edge while args stream) behind
 * an "… N earlier lines" marker on top. The same window applies while
 * streaming and after completion so the block never jumps; only `expanded`
 * (ctrl+o) uncaps it.
 *
 * `prefix` (raw, e.g. a dim tree gutter) is prepended to the marker line so
 * nested previews stay aligned. `expandHint: false` drops the "ctrl+o: Expand"
 * suffix for callers that cap even inside the expanded view (task recent
 * output), where the hint would point the wrong way.
 */
export function capPreviewLines(
	lines: string[],
	theme: Theme,
	options: { max?: number; expanded?: boolean; prefix?: string; expandHint?: boolean } = {},
): string[] {
	if (options.expanded) return lines;
	const max = options.max ?? previewWindowRows();
	if (lines.length <= max) return lines;
	const visible = max <= 1 ? [] : lines.slice(lines.length - (max - 1));
	const hidden = lines.length - visible.length;
	const hint = options.expandHint === false ? "" : formatExpandHint(theme, false, true);
	const marker = `… ${hidden} earlier ${pluralize("line", hidden)}${hint ? ` ${hint}` : ""}`;
	return [`${options.prefix ?? ""}${theme.fg("dim", marker)}`, ...visible];
}

export function formatMeta(meta: string[], theme: Theme): string {
	return meta.length > 0 ? ` ${theme.fg("muted", meta.join(theme.sep.dot))}` : "";
}

function sanitizeErrorText(message: string | undefined): string {
	const clean = (message ?? "").replace(/^Error:\s*/, "").trim();
	return clean ? replaceTabs(truncateToWidth(clean, TRUNCATE_LENGTHS.LINE)) : "Unknown error";
}

export function formatErrorMessage(message: string | undefined, theme: Theme): string {
	return `${theme.styledSymbol("status.error", "error")} ${theme.fg("error", `Error: ${sanitizeErrorText(message)}`)}`;
}

/**
 * Error message rendered as a subordinate detail line beneath a status header
 * that already carries the error icon (e.g. ` Write: <path>`). The header's
 * icon already signals failure, so this omits the redundant error symbol and
 * "Error:" prefix that `formatErrorMessage` adds for standalone single-line
 * errors, indenting two columns to sit under the header title instead.
 */
export function formatErrorDetail(message: string | undefined, theme: Theme): string {
	return `  ${theme.fg("error", sanitizeErrorText(message))}`;
}

export function formatEmptyMessage(message: string, theme: Theme): string {
	return `${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", message)}`;
}

// =============================================================================
// Code Frame Formatting
// =============================================================================

export type CodeFrameMarker = "" | " " | "*" | "+" | "-" | ">";

export function formatCodeFrameLine(
	marker: CodeFrameMarker,
	lineNumber: string | number,
	content: string,
	lineNumberWidth: number,
): string {
	const markerText = marker.trim();
	const lineNumberText = String(lineNumber).trim();
	const gutterText = markerText && lineNumberText ? `${markerText}${lineNumberText}` : lineNumberText || markerText;
	return `${gutterText.padStart(lineNumberWidth + 1, " ")}│${content}`;
}

// =============================================================================
// Tool UI Helpers
// =============================================================================

export type ToolUIColor = "success" | "error" | "warning" | "accent" | "muted";

export interface ToolUITitleOptions {
	bold?: boolean;
}

export function formatTitle(label: string, theme: Theme, options?: ToolUITitleOptions): string {
	const content = options?.bold === false ? label : theme.bold(label);
	return theme.fg("toolTitle", content);
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

interface ParsedDiagnostic {
	filePath: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	source?: string;
	message: string;
	code?: string;
}

/**
 * Diagnostic text as it is shown to a reader: tabs replaced, nothing else touched.
 *
 * A diagnostic message carries a compiler's own spacing, and a literal tab in a rendered line lands
 * wherever the terminal's tab stops happen to be, so a column marker under it points at the wrong
 * column. The LSP renderer had a byte-identical private copy of this, so the two surfaces that show
 * diagnostics could have disagreed about what "display text" means.
 */
export function sanitizeDiagnosticDisplayText(text: string): string {
	return replaceTabs(text);
}

function getSeverityRank(severity: ParsedDiagnostic["severity"]): number {
	switch (severity) {
		case "error":
			return 0;
		case "warning":
			return 1;
		case "info":
			return 2;
		case "hint":
			return 3;
	}
}

function parseDiagnosticMessage(msg: string): ParsedDiagnostic | null {
	const match = msg.match(/^(.+?):(\d+):(\d+)\s+\[(\w+)\]\s+(?:\[([^\]]+)\]\s+)?(.+?)(?:\s+\(([^)]+)\))?$/);
	if (!match) return null;
	return {
		filePath: sanitizeDiagnosticDisplayText(match[1]),
		line: parseInt(match[2], 10),
		col: parseInt(match[3], 10),
		severity: match[4] as ParsedDiagnostic["severity"],
		source: match[5] ? sanitizeDiagnosticDisplayText(match[5]) : undefined,
		message: sanitizeDiagnosticDisplayText(match[6]),
		code: match[7] ? sanitizeDiagnosticDisplayText(match[7]) : undefined,
	};
}

export function formatDiagnostics(
	diag: { errored: boolean; summary: string; messages: string[] },
	expanded: boolean,
	theme: Theme,
	getLangIcon: (filePath: string) => string,
	options?: { title?: string },
): string {
	if (diag.messages.length === 0) return "";

	const byFile = new Map<string, ParsedDiagnostic[]>();
	const unparsed: string[] = [];

	for (const msg of diag.messages) {
		const parsed = parseDiagnosticMessage(msg);
		if (parsed) {
			const existing = byFile.get(parsed.filePath) ?? [];
			existing.push(parsed);
			byFile.set(parsed.filePath, existing);
		} else {
			unparsed.push(sanitizeDiagnosticDisplayText(msg));
		}
	}

	for (const diagnostics of byFile.values()) {
		diagnostics.sort((a, b) => {
			const severityCompare = getSeverityRank(a.severity) - getSeverityRank(b.severity);
			if (severityCompare !== 0) return severityCompare;
			if (a.line !== b.line) return a.line - b.line;
			if (a.col !== b.col) return a.col - b.col;
			return a.message.localeCompare(b.message);
		});
	}

	const headerIcon = diag.errored
		? theme.styledSymbol("status.error", "error")
		: theme.styledSymbol("status.warning", "warning");
	const summary = sanitizeDiagnosticDisplayText(diag.summary);
	const summaryTag = summary ? ` ${theme.fg("dim", `(${summary})`)}` : "";
	let output = `\n\n${headerIcon} ${theme.fg("toolTitle", options?.title ?? "Diagnostics")}${summaryTag}`;

	const maxDiags = expanded ? diag.messages.length : 5;
	let diagsShown = 0;

	const files = Array.from(byFile.entries());

	// Count total diagnostics for "... X more" calculation
	const totalParsedDiags = files.reduce((sum, [, diags]) => sum + diags.length, 0);
	const totalDiags = totalParsedDiags + unparsed.length;

	// Helper to check if this is the very last item in the tree
	const isTreeEnd = (fileIdx: number, diagIdx: number | null, unparsedIdx: number | null): boolean => {
		const willShowMore = totalDiags > diagsShown + 1;
		if (willShowMore) return false;

		if (unparsedIdx !== null) {
			return unparsedIdx === unparsed.length - 1;
		}
		if (diagIdx !== null) {
			const isLastDiagInFile = diagIdx === files[fileIdx][1].length - 1;
			const isLastFile = fileIdx === files.length - 1;
			return isLastDiagInFile && isLastFile && unparsed.length === 0;
		}
		// File node - never the tree end if it has diagnostics
		return false;
	};

	for (let fi = 0; fi < files.length && diagsShown < maxDiags; fi++) {
		const [filePath, diagnostics] = files[fi];
		// File is "last" only if no more files AND no unparsed AND we'll show all diags AND no "... X more"
		const remainingDiagsInFile = diagnostics.length;
		const remainingDiagsAfter = files.slice(fi + 1).reduce((sum, [, d]) => sum + d.length, 0) + unparsed.length;
		const willShowAllRemaining = diagsShown + remainingDiagsInFile + remainingDiagsAfter <= maxDiags;
		const isLastFileNode = fi === files.length - 1 && unparsed.length === 0 && willShowAllRemaining;
		const fileBranch = isLastFileNode ? theme.tree.last : theme.tree.branch;

		// The badge carries its own trailing space, so a preset without a glyph for this
		// language leaves the path directly after the branch instead of one column adrift.
		const fileIcon = getLangIcon(filePath);
		const badge = fileIcon ? `${theme.fg("muted", fileIcon)} ` : "";
		output += `\n ${theme.fg("dim", fileBranch)} ${badge}${theme.fg("accent", filePath)}`;

		for (let di = 0; di < diagnostics.length && diagsShown < maxDiags; di++) {
			const d = diagnostics[di];
			const isLastDiagInFile = di === diagnostics.length - 1;
			// This is the last visible diag in file if it's actually last OR we're about to hit the limit
			const atDisplayLimit = diagsShown + 1 >= maxDiags;
			const isLastVisibleInFile = isLastDiagInFile || atDisplayLimit;
			// Check if this is the last visible item in the entire tree
			const isVeryLast = isTreeEnd(fi, di, null);
			const diagBranch = isLastFileNode
				? isLastVisibleInFile || isVeryLast
					? `  ${theme.tree.last}`
					: `  ${theme.tree.branch}`
				: isLastVisibleInFile || isVeryLast
					? `${theme.tree.vertical} ${theme.tree.last}`
					: `${theme.tree.vertical} ${theme.tree.branch}`;

			const sevIcon =
				d.severity === "error"
					? theme.styledSymbol("status.error", "error")
					: d.severity === "warning"
						? theme.styledSymbol("status.warning", "warning")
						: theme.styledSymbol("status.info", "muted");
			const location = theme.fg("dim", `:${d.line}:${d.col}`);
			const codeTag = d.code ? theme.fg("dim", ` (${d.code})`) : "";
			const msgColor = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "toolOutput";

			output += `\n ${theme.fg("dim", diagBranch)} ${sevIcon}${location} ${theme.fg(msgColor, d.message)}${codeTag}`;
			diagsShown++;
		}
	}

	for (let ui = 0; ui < unparsed.length && diagsShown < maxDiags; ui++) {
		const msg = unparsed[ui];
		const isVeryLast = isTreeEnd(-1, null, ui);
		const branch = isVeryLast ? theme.tree.last : theme.tree.branch;
		const color = msg.includes("[error]") ? "error" : msg.includes("[warning]") ? "warning" : "dim";
		output += `\n ${theme.fg("dim", branch)} ${theme.fg(color, msg)}`;
		diagsShown++;
	}

	if (totalDiags > diagsShown) {
		const remaining = totalDiags - diagsShown;
		output += `\n ${theme.fg("dim", theme.tree.last)} ${theme.fg(
			"muted",
			`… ${remaining} more`,
		)} ${formatExpandHint(theme)}`;
	}

	return output;
}

// =============================================================================
// Diff Utilities
// =============================================================================

export interface DiffStats {
	added: number;
	removed: number;
	hunks: number;
	lines: number;
}

export function getDiffStats(diffText: string): DiffStats {
	const lines = diffText ? diffText.split("\n") : [];
	let added = 0;
	let removed = 0;
	let hunks = 0;
	let inHunk = false;

	for (const line of lines) {
		const isAdded = line.startsWith("+");
		const isRemoved = line.startsWith("-");
		const isChange = isAdded || isRemoved;

		if (isAdded) added++;
		if (isRemoved) removed++;

		if (isChange && !inHunk) {
			hunks++;
			inHunk = true;
		} else if (!isChange) {
			inHunk = false;
		}
	}

	return { added, removed, hunks, lines: lines.length };
}

export function formatDiffStats(added: number, removed: number, hunks: number, theme: Theme): string {
	const parts: string[] = [];
	if (added > 0) parts.push(theme.fg("toolDiffAdded", `+${added}`));
	if (removed > 0) parts.push(theme.fg("toolDiffRemoved", `-${removed}`));
	if (hunks > 0) parts.push(theme.fg("dim", formatCount("hunk", hunks)));
	return parts.join(theme.fg("dim", " / "));
}

interface DiffSegment {
	lines: string[];
	isChange: boolean;
	isEllipsis: boolean;
}

function parseDiffSegments(lines: string[]): DiffSegment[] {
	const segments: DiffSegment[] = [];
	let current: DiffSegment | null = null;

	for (const line of lines) {
		const isChange = line.startsWith("+") || line.startsWith("-");
		const isEllipsis = line.trimStart().startsWith("...") || line.trim().length === 0;

		if (isEllipsis) {
			if (current) segments.push(current);
			segments.push({ lines: [line], isChange: false, isEllipsis: true });
			current = null;
		} else if (!current || current.isChange !== isChange) {
			if (current) segments.push(current);
			current = { lines: [line], isChange, isEllipsis: false };
		} else {
			current.lines.push(line);
		}
	}

	if (current) segments.push(current);
	return segments;
}

export function truncateDiffByHunk(
	diffText: string,
	maxHunks: number,
	maxLines: number,
	options?: { fromTail?: boolean },
): { text: string; hiddenHunks: number; hiddenLines: number } {
	if (options?.fromTail) {
		// Streaming previews want to track the tail of the diff as new hunks
		// arrive. Reversing the line buffer reuses the head-mode logic without
		// duplicating the segment-budget bookkeeping: hunk runs survive
		// reversal (a continuous `+`/`-` block stays contiguous) and so do the
		// per-line `+`/`-` markers, so getDiffStats yields identical counts.
		const reversed = (diffText ?? "").split("\n").reverse().join("\n");
		const result = truncateDiffByHunk(reversed, maxHunks, maxLines);
		return {
			text: result.text.split("\n").reverse().join("\n"),
			hiddenHunks: result.hiddenHunks,
			hiddenLines: result.hiddenLines,
		};
	}
	const lines = diffText ? diffText.split("\n") : [];
	const totalStats = getDiffStats(diffText);

	if (lines.length <= maxLines && totalStats.hunks <= maxHunks) {
		return { text: diffText, hiddenHunks: 0, hiddenLines: 0 };
	}

	const segments = parseDiffSegments(lines);

	const changeSegments = segments.filter(s => s.isChange);
	const changeLineCount = changeSegments.reduce((sum, s) => sum + s.lines.length, 0);

	if (changeLineCount > maxLines) {
		const kept: string[] = [];
		let keptHunks = 0;

		for (const seg of segments) {
			if (seg.isChange) {
				keptHunks++;
				if (keptHunks > maxHunks) break;
			}
			kept.push(...seg.lines);
			if (kept.length >= maxLines) break;
		}

		const keptStats = getDiffStats(kept.join("\n"));
		return {
			text: kept.join("\n"),
			hiddenHunks: Math.max(0, totalStats.hunks - keptStats.hunks),
			hiddenLines: Math.max(0, lines.length - kept.length),
		};
	}

	const contextBudget = maxLines - changeLineCount;
	const contextSegments = segments.filter(s => !s.isChange && !s.isEllipsis);
	const totalContextLines = contextSegments.reduce((sum, s) => sum + s.lines.length, 0);

	const kept: string[] = [];
	let keptHunks = 0;

	if (totalContextLines <= contextBudget) {
		for (const seg of segments) {
			if (seg.isChange) {
				keptHunks++;
				if (keptHunks > maxHunks) break;
			}
			kept.push(...seg.lines);
		}
	} else {
		const contextRatio = contextSegments.length > 0 ? contextBudget / totalContextLines : 0;

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];

			if (seg.isChange) {
				keptHunks++;
				if (keptHunks > maxHunks) break;
				kept.push(...seg.lines);
			} else if (seg.isEllipsis) {
				kept.push(...seg.lines);
			} else {
				const allowedLines = Math.max(1, Math.floor(seg.lines.length * contextRatio));
				const isBeforeChange = segments[i + 1]?.isChange;
				const isAfterChange = segments[i - 1]?.isChange;

				if (isBeforeChange && isAfterChange) {
					const half = Math.ceil(allowedLines / 2);
					if (seg.lines.length > allowedLines) {
						kept.push(...seg.lines.slice(0, half));
						kept.push("");
						kept.push(...seg.lines.slice(-half));
					} else {
						kept.push(...seg.lines);
					}
				} else if (isBeforeChange) {
					kept.push(...seg.lines.slice(-allowedLines));
				} else if (isAfterChange) {
					kept.push(...seg.lines.slice(0, allowedLines));
				} else {
					kept.push(...seg.lines.slice(0, Math.min(allowedLines, 2)));
				}
			}
		}
	}

	const keptStats = getDiffStats(kept.join("\n"));
	return {
		text: kept.join("\n"),
		hiddenHunks: Math.max(0, totalStats.hunks - keptStats.hunks),
		hiddenLines: Math.max(0, lines.length - kept.length),
	};
}

// =============================================================================
// Path Utilities
// =============================================================================

// Node-side path shortener: collapses the *real* home dir (`os.homedir()`, or
// an explicit `homeDir`) to `~`, normalizes Win32 separators, and tolerates
// non-string input. The browser packages cannot call `os.homedir()`, so they
// share a separate `/Users|/home`-heuristic owner in `@veyyon/tool-render`
// (`src/util.ts`). Two owners, one per runtime boundary, is deliberate here —
// not an accidental duplicate.
export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") {
		return "";
	}
	const home = homeDir ?? os.homedir();
	if (home && filePath.startsWith(home)) {
		const suffix = filePath.slice(home.length);
		if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
			return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
		}
	}
	return filePath;
}

export function formatToolWorkingDirectory(workdir: string | undefined, projectDir: string): string | undefined {
	if (!workdir) return undefined;
	const resolvedProjectDir = path.resolve(projectDir);
	const resolvedWorkdir = path.resolve(projectDir, workdir);
	if (resolvedWorkdir === resolvedProjectDir) {
		return undefined;
	}
	const relativePath = path.relative(resolvedProjectDir, resolvedWorkdir);
	const isWithinProject =
		relativePath.length > 0 && !relativePath.startsWith("..") && !relativePath.startsWith(`..${path.sep}`);
	const displayWorkdir = isWithinProject ? relativePath : shortenPath(resolvedWorkdir);
	return replaceTabs(displayWorkdir);
}

export function formatScreenshot(opts: {
	saveFullRes: boolean;
	savedMimeType: string;
	savedByteLength: number;
	dest: string;
	resized: ResizedImage;
}): string[] {
	const lines = ["Screenshot captured"];
	if (opts.saveFullRes) {
		lines.push(
			`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`,
		);
		lines.push(
			`Model: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`,
		);
	} else {
		lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.buffer.length / 1024).toFixed(2)} KB)`);
		lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
	}
	if (opts.resized.decodeFailed) {
		lines.push("Resize: image decoder failed; using original image bytes");
	}
	const dimensionNote = formatDimensionNote(opts.resized);
	if (dimensionNote) {
		lines.push(dimensionNote);
	}
	return lines;
}

export function wrapBrackets(text: string, theme: Theme): string {
	return `${theme.format.bracketLeft}${text}${theme.format.bracketRight}`;
}

export const PARSE_ERRORS_LIMIT = 20;

export function dedupeParseErrors(errors: string[] | undefined): string[] {
	if (!errors || errors.length === 0) return [];
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const error of errors) {
		if (seen.has(error)) continue;
		seen.add(error);
		deduped.push(error);
	}
	return deduped;
}

export function formatParseErrors(errors: string[], total?: number): string[] {
	const deduped = dedupeParseErrors(errors);
	if (deduped.length === 0) return [];
	const fullCount = total ?? deduped.length;
	const capped = deduped.slice(0, PARSE_ERRORS_LIMIT);
	const header = fullCount > capped.length ? `Parse issues (${capped.length} / ${fullCount}):` : "Parse issues:";
	return [header, ...capped.map(err => `- ${err}`)];
}

/**
 * Cap an upstream parse-error list to {@link PARSE_ERRORS_LIMIT} unique entries,
 * preserving the original deduplicated total. Use this at the source so tool
 * details never carry thousands of per-file parse errors into traces or
 * renderers.
 */
export function capParseErrors(
	errors: string[] | undefined,
	limit: number = PARSE_ERRORS_LIMIT,
): { errors: string[]; total: number } {
	const deduped = dedupeParseErrors(errors);
	return { errors: deduped.slice(0, limit), total: deduped.length };
}

// =============================================================================
// Renderer helpers shared by search / find / ast tools
// =============================================================================

/**
 * Standard width+expand keyed render cache used by every search-style tool
 * renderer. `compute` re-runs only when the cache key changes; the returned
 * Component is the canonical `{ render, invalidate }` pair.
 */
export function createCachedComponent(
	getExpanded: () => boolean,
	compute: (width: number, expanded: boolean) => string[],
	options: { paddingX?: number } = {},
): Component {
	let cached: { key: bigint; lines: string[] } | undefined;
	return {
		render(width: number): readonly string[] {
			const expanded = getExpanded();
			const key = new Hasher().bool(expanded).u32(width).digest();
			if (cached?.key === key) return cached.lines;
			const paddingX = Math.max(0, options.paddingX ?? 0);
			const innerWidth = Math.max(1, width - paddingX * 2);
			const lines = compute(innerWidth, expanded);
			const pad = paddingX === 0 ? "" : " ".repeat(paddingX);
			const paddedLines = paddingX === 0 ? lines : lines.map(line => `${pad}${line}${pad}`);
			cached = { key, lines: paddedLines };
			return paddedLines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

/**
 * Single-slot memo for an expensive rendered string (syntax highlighting, diff
 * coloring) keyed by the exact inputs that shape the bytes: theme instance,
 * expanded state, a caller-chosen salt (path/language), and the source content.
 * Field-wise comparison instead of a concatenated key string: a cache hit costs
 * one string value-compare (engines short-circuit on length) and a miss never
 * allocates a key. Comparing the {@link Theme} by reference is sound because
 * theme switches replace the instance wholesale (`setTheme`/`previewTheme`/
 * `setSymbolPreset` in modes/theme/theme.ts) — themes are never mutated in
 * place.
 */
export interface RenderedStringCache {
	theme: Theme | null;
	expanded: boolean;
	salt: string;
	content: string;
	value: string;
}

export function createRenderedStringCache(): RenderedStringCache {
	return { theme: null, expanded: false, salt: "", content: "", value: "" };
}

/** Drop the memo so the next lookup re-renders (e.g. the render function identity changed). */
export function invalidateRenderedStringCache(cache: RenderedStringCache): void {
	cache.theme = null;
}

export function cachedRenderedString(
	cache: RenderedStringCache | undefined,
	theme: Theme,
	expanded: boolean,
	salt: string,
	content: string,
	render: () => string,
): string {
	if (
		cache !== undefined &&
		cache.theme === theme &&
		cache.expanded === expanded &&
		cache.salt === salt &&
		cache.content === content
	) {
		return cache.value;
	}
	const value = render();
	if (cache !== undefined) {
		cache.theme = theme;
		cache.expanded = expanded;
		cache.salt = salt;
		cache.content = content;
		cache.value = value;
	}
	return value;
}

/**
 * Append the indented bullet list of parse errors (capped at
 * {@link PARSE_ERRORS_LIMIT}) to `lines`, with an overflow summary line if the
 * total exceeds the cap. No-op when `parseErrors` is empty.
 */
export function appendParseErrorsBulletList(
	lines: string[],
	parseErrors: readonly string[] | undefined,
	theme: Theme,
	total?: number,
): void {
	if (!parseErrors || parseErrors.length === 0) return;
	const fullCount = total ?? parseErrors.length;
	const capped = parseErrors.slice(0, PARSE_ERRORS_LIMIT);
	for (const err of capped) {
		lines.push(theme.fg("warning", `  - ${err}`));
	}
	if (fullCount > capped.length) {
		lines.push(theme.fg("dim", `  … ${fullCount - capped.length} more`));
	}
}

/**
 * Human-readable summary string for the parse-issues count, capped by
 * {@link PARSE_ERRORS_LIMIT}.
 */
export function formatParseErrorsCountLabel(parseErrors: readonly string[], total?: number): string {
	const fullCount = total ?? parseErrors.length;
	return fullCount > PARSE_ERRORS_LIMIT
		? `${PARSE_ERRORS_LIMIT} / ${fullCount} parse issues`
		: formatCount("parse issue", fullCount);
}

// =============================================================================
// LSP Batching
// =============================================================================

const LSP_BATCH_TOOLS = new Set(["edit", "write"]);

export interface LspBatchRequest {
	id: string;
	flush: boolean;
}

export function getLspBatchRequest(toolCall: ToolCallContext | undefined): LspBatchRequest | undefined {
	if (!toolCall) {
		return undefined;
	}
	const hasOtherWrites = toolCall.toolCalls.some(
		(call, index) => index !== toolCall.index && LSP_BATCH_TOOLS.has(call.name),
	);
	if (!hasOtherWrites) {
		return undefined;
	}
	const hasLaterWrites = toolCall.toolCalls.slice(toolCall.index + 1).some(call => LSP_BATCH_TOOLS.has(call.name));
	return { id: toolCall.batchId, flush: !hasLaterWrites };
}
