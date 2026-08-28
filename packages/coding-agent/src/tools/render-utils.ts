import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallContext } from "@veyyon/agent-core";
import type { Ellipsis } from "@veyyon/natives";
import type { Component } from "@veyyon/tui";
import { getKeybindings, replaceTabs, truncateToWidth } from "@veyyon/tui";
import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { formatCount, pluralize } from "@veyyon/utils/format";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { formatKeyHints, type KeyId } from "../config/keybindings";
import { settings } from "../config/settings-instance";
import type { Theme } from "../modes/theme/theme";
import { Hasher } from "../tui/utils";
import { formatDimensionNote, type ResizedImage } from "../utils/image-resize";
import { isPathWithinCwd } from "./path-utils";

export { Ellipsis } from "@veyyon/natives";
export { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@veyyon/tui";

export function resolveImageOptions(): { maxWidthCells: number; maxHeightCells?: number } {
	const maxWidthCells = settings.get("tui.maxInlineImageColumns");
	const rowSetting = Math.max(0, settings.get("tui.maxInlineImageRows"));
	const viewportRows = process.stdout.rows;
	const viewportFraction = viewportRows ? Math.floor(viewportRows * 0.6) : 0;
	let maxHeightCells: number | undefined;
	if (rowSetting === 0) {
		maxHeightCells = viewportFraction || undefined;
	} else if (viewportFraction > 0) {
		maxHeightCells = Math.min(rowSetting, viewportFraction);
	} else {
		maxHeightCells = rowSetting;
	}
	return { maxWidthCells, maxHeightCells };
}

export const PREVIEW_LIMITS = {
	COLLAPSED_LINES: 3,
	EXPANDED_LINES: 12,
	COLLAPSED_ITEMS: 8,
	OUTPUT_COLLAPSED: 3,
	OUTPUT_EXPANDED: 10,
	DIFF_COLLAPSED_HUNKS: 8,
	DIFF_COLLAPSED_LINES: 40,
} as const;

export const DEFAULT_TERMINAL_PREVIEW_LINES = 10;

export const TRUNCATE_LENGTHS = {
	TITLE: 60,
	CONTENT: 80,
	LONG: 100,
	LINE: 110,
	SHORT: 40,
	CHIP: 24,
	RECAP: 280,
} as const;

const EXPAND_ACTION = "app.tools.expand";
const DEFAULT_EXPAND_KEY: KeyId = "ctrl+o";

export function expandKeyHint(): string {
	const keys = getKeybindings().getKeys(EXPAND_ACTION);
	return formatKeyHints(keys.length > 0 ? keys : [DEFAULT_EXPAND_KEY]);
}

export function getPreviewLines(text: string, maxLines: number, maxLineLen: number, ellipsis?: Ellipsis): string[] {
	const result: string[] = [];
	let start = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text.charCodeAt(i) === 0x0a) {
			const line = text.slice(start, i);
			if (line.trim()) {
				result.push(truncateToWidth(line.trim(), maxLineLen, ellipsis));
				if (result.length >= maxLines) break;
			}
			start = i + 1;
		}
	}
	return result;
}

export function previewLine(text: string, maxWidth: number, ellipsis?: Ellipsis): string {
	return truncateToWidth(collapseWhitespace(text), maxWidth, ellipsis);
}

export const PROGRESS_RUN_MIN_LINES = 4;

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

export interface CollapsedOutputRow {
	readonly text: string;
	readonly hidden: number;
}

function progressRunKey(line: string): string | undefined {
	const bare = line.includes("\u001b") ? stripAnsi(line) : line;
	const token = /^\S+/.exec(bare.trim())?.[0];
	if (token === undefined) return undefined;
	if (DIAGNOSTIC_LEAD_TOKENS.has(token.replace(/:$/, "").toLowerCase())) return undefined;
	const shaped = /^[A-Z][A-Za-z]*:?$/.test(token) || /^[a-z]+:$/.test(token) || /^[[(#]/.test(token);
	return shaped ? token.replace(/\d+/g, "#") : undefined;
}

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

export function renderCollapsedOutputLines(
	lines: readonly string[],
	theme: Theme,
	styleLine: (line: string) => string = line => theme.fg("toolOutput", replaceTabs(line)),
): string[] {
	const rows = collapseProgressRuns(lines);
	const result = new Array<string>(rows.length);
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		const text = styleLine(row.text);
		result[ri] = row.hidden === 0 ? text : `${text}${theme.fg("dim", ` … +${row.hidden} earlier`)}`;
	}
	return result;
}

export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		return u.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export { formatAge, formatBytes, formatCount, formatDuration, pluralize } from "@veyyon/utils/format";
export type { ToolUIStatus } from "./tool-ui-status";
export { formatStatusIcon } from "./tool-ui-status";

export function formatExpandHint(theme: Theme, expanded?: boolean, hasMore?: boolean): string {
	if (expanded) return "";
	if (hasMore === false) return "";
	const chevron = theme.nav?.expand ?? "▸";
	return theme.fg("dim", `${chevron} ${expandKeyHint()} expand`);
}

export function formatBadge(label: string, color: ToolUIColor, theme: Theme): string {
	const left = theme.format.bracketLeft;
	const right = theme.format.bracketRight;
	return theme.fg(color, `${left}${label}${right}`);
}

export function formatMoreItems(remaining: number, itemType: string): string {
	const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
	return `… ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

const PREVIEW_WINDOW_RESERVED_ROWS = 20;
const PREVIEW_WINDOW_MIN_LINES = 6;
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

export function previewWindowRows(): number {
	const rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS;
	return Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS);
}

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
	if (!clean) return "Unknown error";
	return replaceTabs(truncateToWidth(shortenEmbeddedPaths(clean), TRUNCATE_LENGTHS.LINE));
}

export function formatErrorMessage(message: string | undefined, theme: Theme): string {
	return `${theme.styledSymbol("status.error", "error")} ${theme.fg("error", `Error: ${sanitizeErrorText(message)}`)}`;
}

export function formatErrorDetail(message: string | undefined, theme: Theme): string {
	return `  ${theme.fg("error", sanitizeErrorText(message))}`;
}

export function formatEmptyMessage(message: string, theme: Theme): string {
	return `${theme.styledSymbol("status.warning", "warning")} ${theme.fg("muted", message)}`;
}

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

export type ToolUIColor = "success" | "error" | "warning" | "accent" | "muted";

export interface ToolUITitleOptions {
	bold?: boolean;
}

export function formatTitle(label: string, theme: Theme, options?: ToolUITitleOptions): string {
	const content = options?.bold === false ? label : theme.bold(label);
	return theme.fg("toolTitle", content);
}

interface ParsedDiagnostic {
	filePath: string;
	line: number;
	col: number;
	severity: "error" | "warning" | "info" | "hint";
	source?: string;
	message: string;
	code?: string;
}

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

	const totalParsedDiags = files.reduce((sum, [, diags]) => sum + diags.length, 0);
	const totalDiags = totalParsedDiags + unparsed.length;

	for (let fi = 0; fi < files.length && diagsShown < maxDiags; fi++) {
		const [filePath, diagnostics] = files[fi];

		const fileIcon = getLangIcon(filePath);
		const badge = fileIcon ? `${theme.fg("muted", fileIcon)} ` : "";
		output += `\n${badge}${theme.fg("accent", filePath)}`;

		for (let di = 0; di < diagnostics.length && diagsShown < maxDiags; di++) {
			const d = diagnostics[di];

			const sevIcon =
				d.severity === "error"
					? theme.styledSymbol("status.error", "error")
					: d.severity === "warning"
						? theme.styledSymbol("status.warning", "warning")
						: theme.styledSymbol("status.info", "muted");
			const location = theme.fg("dim", `:${d.line}:${d.col}`);
			const codeTag = d.code ? theme.fg("dim", ` (${d.code})`) : "";
			const msgColor = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "toolOutput";

			output += `\n  ${sevIcon}${location} ${theme.fg(msgColor, d.message)}${codeTag}`;
			diagsShown++;
		}
	}

	for (let ui = 0; ui < unparsed.length && diagsShown < maxDiags; ui++) {
		const msg = unparsed[ui];
		const color = msg.includes("[error]") ? "error" : msg.includes("[warning]") ? "warning" : "dim";
		output += `\n  ${theme.fg(color, msg)}`;
		diagsShown++;
	}

	if (totalDiags > diagsShown) {
		const remaining = totalDiags - diagsShown;
		output += `\n${theme.fg("dim", `… ${remaining} more`)} ${formatExpandHint(theme)}`;
	}

	return output;
}

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

	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
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
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
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
function pushAll(dst: string[], src: readonly string[]): void {
	for (let i = 0; i < src.length; i++) dst.push(src[i]!);
}
function pushRange(dst: string[], src: readonly string[], start: number, end: number): void {
	if (start < 0) start = Math.max(0, src.length + start);
	for (let i = start; i < end && i < src.length; i++) dst.push(src[i]!);
}

export function truncateDiffByHunk(
	diffText: string,
	maxHunks: number,
	maxLines: number,
	options?: { fromTail?: boolean },
): { text: string; hiddenHunks: number; hiddenLines: number } {
	if (options?.fromTail) {
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

	let changeLineCount = 0;
	for (let i = 0; i < segments.length; i++) {
		if (segments[i]!.isChange) changeLineCount += segments[i]!.lines.length;
	}

	if (changeLineCount > maxLines) {
		const kept: string[] = [];
		let keptHunks = 0;

		for (let si = 0; si < segments.length; si++) {
			const seg = segments[si]!;
			if (seg.isChange) {
				keptHunks++;
				if (keptHunks > maxHunks) break;
			}
			pushAll(kept, seg.lines);
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
	let totalContextLines = 0;
	let contextSegmentCount = 0;
	for (let i = 0; i < segments.length; i++) {
		const s = segments[i]!;
		if (!s.isChange && !s.isEllipsis) {
			totalContextLines += s.lines.length;
			contextSegmentCount++;
		}
	}

	const kept: string[] = [];
	let keptHunks = 0;

	if (totalContextLines <= contextBudget) {
		for (let si = 0; si < segments.length; si++) {
			const seg = segments[si]!;
			if (seg.isChange) {
				keptHunks++;
				if (keptHunks > maxHunks) break;
			}
			pushAll(kept, seg.lines);
		}
	} else {
		const contextRatio = contextSegmentCount > 0 ? contextBudget / totalContextLines : 0;

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];

			if (seg.isChange) {
				keptHunks++;
				if (keptHunks > maxHunks) break;
				pushAll(kept, seg.lines);
			} else if (seg.isEllipsis) {
				pushAll(kept, seg.lines);
			} else {
				const allowedLines = Math.max(1, Math.floor(seg.lines.length * contextRatio));
				const isBeforeChange = segments[i + 1]?.isChange;
				const isAfterChange = segments[i - 1]?.isChange;

				if (isBeforeChange && isAfterChange) {
					const half = Math.ceil(allowedLines / 2);
					if (seg.lines.length > allowedLines) {
						pushRange(kept, seg.lines, 0, half);
						kept.push("");
						pushRange(kept, seg.lines, -half, seg.lines.length);
					} else {
						pushAll(kept, seg.lines);
					}
				} else if (isBeforeChange) {
					pushRange(kept, seg.lines, -allowedLines, seg.lines.length);
				} else if (isAfterChange) {
					pushRange(kept, seg.lines, 0, allowedLines);
				} else {
					pushRange(kept, seg.lines, 0, Math.min(allowedLines, 2));
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

export function formatScopePaths(paths: string | readonly string[]): string {
	const list = typeof paths === "string" ? [paths] : paths;
	return truncateToWidth(list.map(entry => shortenPath(entry)).join(", "), TRUNCATE_LENGTHS.CONTENT);
}

export function formatScopeMeta(paths: string | readonly string[]): string {
	return `in ${formatScopePaths(paths)}`;
}

export function shortenEmbeddedPaths(text: string, homeDir?: string): string {
	return text
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			return `${leading}${shortenPath(segment.slice(leading.length, end), homeDir)}${trailing}`;
		})
		.join(" ");
}

export function formatToolWorkingDirectory(workdir: string | undefined, projectDir: string): string | undefined {
	if (!workdir) return undefined;
	const resolvedProjectDir = path.resolve(projectDir);
	const resolvedWorkdir = path.resolve(projectDir, workdir);
	if (resolvedWorkdir === resolvedProjectDir) {
		return undefined;
	}
	const relativePath = path.relative(resolvedProjectDir, resolvedWorkdir);
	const displayWorkdir = isPathWithinCwd(resolvedWorkdir, resolvedProjectDir)
		? relativePath
		: shortenPath(resolvedWorkdir);
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
	for (let ei = 0; ei < errors.length; ei++) {
		if (seen.has(errors[ei]!)) continue;
		seen.add(errors[ei]!);
		deduped.push(errors[ei]!);
	}
	return deduped;
}

export function formatParseErrors(errors: string[], total?: number): string[] {
	const deduped = dedupeParseErrors(errors);
	if (deduped.length === 0) return [];
	const fullCount = total ?? deduped.length;
	const capped = deduped.slice(0, PARSE_ERRORS_LIMIT);
	const header = fullCount > capped.length ? `Parse issues (${capped.length} / ${fullCount}):` : "Parse issues:";
	const result = new Array<string>(capped.length + 1);
	result[0] = header;
	for (let ei = 0; ei < capped.length; ei++) result[ei + 1] = `- ${capped[ei]!}`;
	return result;
}

export function capParseErrors(
	errors: string[] | undefined,
	limit: number = PARSE_ERRORS_LIMIT,
): { errors: string[]; total: number } {
	const deduped = dedupeParseErrors(errors);
	return { errors: deduped.slice(0, limit), total: deduped.length };
}

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
			const paddedLines =
				paddingX === 0
					? lines
					: (() => {
							const pl = new Array<string>(lines.length);
							for (let li = 0; li < lines.length; li++) pl[li] = `${pad}${lines[li]!}${pad}`;
							return pl;
						})();
			cached = { key, lines: paddedLines };
			return paddedLines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

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

export function appendParseErrorsBulletList(
	lines: string[],
	parseErrors: readonly string[] | undefined,
	theme: Theme,
	total?: number,
): void {
	if (!parseErrors || parseErrors.length === 0) return;
	const fullCount = total ?? parseErrors.length;
	const capped = parseErrors.slice(0, PARSE_ERRORS_LIMIT);
	for (let ei = 0; ei < capped.length; ei++) {
		lines.push(theme.fg("warning", `  - ${capped[ei]!}`));
	}
	if (fullCount > capped.length) {
		lines.push(theme.fg("dim", `  … ${fullCount - capped.length} more`));
	}
}

export function formatParseErrorsCountLabel(parseErrors: readonly string[], total?: number): string {
	const fullCount = total ?? parseErrors.length;
	return fullCount > PARSE_ERRORS_LIMIT
		? `${PARSE_ERRORS_LIMIT} / ${fullCount} parse issues`
		: formatCount("parse issue", fullCount);
}

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
