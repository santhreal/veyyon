/**
 * What a diagnostics block says, for any host.
 *
 * Three cards show diagnostics — the write card, the edit card and the late-diagnostics message —
 * and each used to receive the same block as a pre-coloured string built against a `Theme`. The
 * parse and the ordering are the same work whatever draws it, so they are here, and the block is
 * stated once as view lines a host lays out. `formatDiagnostics` in `render-utils.ts` is the string
 * form the two unconverted cards still take, and it reads its parse from here rather than keeping a
 * second copy of the grammar.
 */

import { replaceTabs } from "@veyyon/utils/wrap";
import type { ViewLine, ViewSection, ViewSpan } from "@veyyon/view";
import { getLanguageFromPath } from "../../utils/lang-from-path";

/** One diagnostic, as the compiler line it was parsed out of states it. */
export interface ParsedDiagnostic {
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

/** Where a severity sorts within one file: the worst first. */
export function getSeverityRank(severity: ParsedDiagnostic["severity"]): number {
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

export function parseDiagnosticMessage(msg: string): ParsedDiagnostic | null {
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

/** What the tool reports about a run's diagnostics, which is the shape every caller already holds. */
export interface ToolDiagnostics {
	errored: boolean;
	summary: string;
	messages: string[];
}

/** The diagnostics a collapsed card shows before it says how many it kept back. */
const COLLAPSED_DIAGNOSTICS = 5;

/** The two columns a diagnostic sits in under the file it belongs to. */
const NEST_INDENT = "  ";

/**
 * The diagnostics grouped by file, worst first within each.
 *
 * Insertion order across files, which is the order the compiler reported them in: a card that
 * re-sorted the files would move a group a reader is looking at as more diagnostics arrive.
 */
function groupByFile(messages: string[]): { byFile: Map<string, ParsedDiagnostic[]>; unparsed: string[] } {
	const byFile = new Map<string, ParsedDiagnostic[]>();
	const unparsed: string[] = [];
	for (const msg of messages) {
		const parsed = parseDiagnosticMessage(msg);
		if (!parsed) {
			unparsed.push(sanitizeDiagnosticDisplayText(msg));
			continue;
		}
		const existing = byFile.get(parsed.filePath);
		if (existing) existing.push(parsed);
		else byFile.set(parsed.filePath, [parsed]);
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
	return { byFile, unparsed };
}

/** The mark a severity carries, as a registry key the host resolves, and the tone that goes with it. */
function severityMark(severity: ParsedDiagnostic["severity"]): ViewSpan {
	if (severity === "error") return { text: "", symbol: "status.error", tone: "error" };
	if (severity === "warning") return { text: "", symbol: "status.warning", tone: "warning" };
	return { text: "", symbol: "status.info", tone: "muted" };
}

/** The tone a diagnostic's own words carry, which is the severity for the two that are failures. */
function messageTone(severity: ParsedDiagnostic["severity"]): "error" | "warning" | "output" {
	if (severity === "error") return "error";
	return severity === "warning" ? "warning" : "output";
}

/**
 * The tone a line the grammar did not match carries, read off the severity the compiler wrote into
 * it: an unparsed line is still a diagnostic, and a card that drew every one of them in the same
 * shade would hide a failure among its notes.
 */
function unparsedTone(msg: string): "error" | "warning" | "dim" {
	if (msg.includes("[error]")) return "error";
	return msg.includes("[warning]") ? "warning" : "dim";
}

/**
 * A diagnostics block as one section, or nothing when the run reported none.
 *
 * The section's first line is its own header — the outcome mark, the title and the summary — rather
 * than a section label, because the header carries a mark and a count that a label is one string
 * with no room for. Every following line is a file the diagnostics belong to or a diagnostic nested
 * under it, and the count the card kept back is the section's `hidden`, so the host words the
 * gesture for seeing the rest.
 */
export function diagnosticsSection(
	diag: ToolDiagnostics,
	expanded: boolean,
	options?: { title?: string },
): ViewSection | undefined {
	if (diag.messages.length === 0) return undefined;

	const { byFile, unparsed } = groupByFile(diag.messages);
	const summary = sanitizeDiagnosticDisplayText(diag.summary);
	const header: ViewSpan[] = [
		diag.errored
			? { text: "", symbol: "status.error", tone: "error" }
			: { text: "", symbol: "status.warning", tone: "warning" },
		{ text: " " },
		{ text: options?.title ?? "Diagnostics", tone: "title" },
	];
	if (summary) header.push({ text: " " }, { text: `(${summary})`, tone: "dim" });

	const lines: ViewLine[] = [header];
	const maxDiags = expanded ? diag.messages.length : COLLAPSED_DIAGNOSTICS;
	let shown = 0;
	const files = Array.from(byFile.entries());
	const total = files.reduce((sum, [, diagnostics]) => sum + diagnostics.length, 0) + unparsed.length;

	for (const [filePath, diagnostics] of files) {
		if (shown >= maxDiags) break;
		// The language is stated even when the path does not name one, which is a file whose language
		// the tool could not tell rather than a line that names no file: a host that marks files marks
		// this one too.
		lines.push([{ text: filePath, tone: "accent", language: getLanguageFromPath(filePath) ?? "" }]);
		for (const diagnostic of diagnostics) {
			if (shown >= maxDiags) break;
			const line: ViewSpan[] = [
				{ text: NEST_INDENT },
				severityMark(diagnostic.severity),
				{ text: `:${diagnostic.line}:${diagnostic.col}`, tone: "dim" },
				{ text: " " },
				{ text: diagnostic.message, tone: messageTone(diagnostic.severity) },
			];
			if (diagnostic.code !== undefined) line.push({ text: ` (${diagnostic.code})`, tone: "dim" });
			lines.push(line);
			shown++;
		}
	}

	for (const msg of unparsed) {
		if (shown >= maxDiags) break;
		lines.push([{ text: NEST_INDENT }, { text: msg, tone: unparsedTone(msg) }]);
		shown++;
	}

	const held = total - shown;
	return { lines, ...(held > 0 ? { hidden: { count: held, revealable: true } } : {}) };
}
