/**
 * Line formatting for read output: hashline headers, line-number prefixes, bracket-context entries,
 * column clipping and the seen-line records a later edit validates against.
 */

import * as path from "node:path";
import { formatHashlineHeader, formatNumberedLine, formatNumberedLines } from "@veyyon/hashline";
import { canonicalSnapshotKey, getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { normalizeToLF } from "../../edit/normalize";
import type { ToolSession } from "../../sdk";
import { truncateLine } from "../../session/streaming-output";
import { type LineEntry, lineEntriesToPlainText } from "../../utils/block-context";
import { formatPathRelativeToCwd } from "../core/path-utils";
import { formatBytes, shortenPath } from "../core/render-utils";
import { ToolError } from "../core/tool-errors";
import type { ReadDisplayContent } from "./read-display";

function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}|${line}`).join("\n");
}

export interface HashlineHeaderContext {
	header: string;
	tag: string;
	fullText?: string;
}

export function formatReadHashlineHeader(displayPath: string, tag: string): string {
	// In-workspace reads collapse to the bare filename for brevity: the edit
	// tool's snapshot-tag recovery rebinds a bare `[name#tag]` onto the in-tree
	// file it uniquely names. Out-of-workspace reads can't lean on that —
	// recovery refuses to redirect a write outside the cwd/sandbox
	// (HashlineFilesystem.allowTagPathRecovery) — so an absolute displayPath
	// must stay directly resolvable, otherwise the basename resolves against
	// cwd, misses, and the edit fails with "File not found" (e.g. ~/.claude/*).
	// `shortenPath` keeps `~/.claude/...` (round-trips through resolveToCwd's ~
	// expansion) instead of leaking the full home path into the read output.
	const anchor = path.isAbsolute(displayPath) ? shortenPath(displayPath) : path.basename(displayPath);
	return formatHashlineHeader(anchor, tag);
}

/**
 * Records the full text under the file's snapshot key so a later edit can anchor on what this
 * read showed. `undefined` when hashlines are off or the path is not an absolute file.
 */
export function recordFullHashlineContext(
	session: ToolSession,
	hashLines: boolean,
	absolutePath: string | undefined,
	fullText: string,
): HashlineHeaderContext | undefined {
	if (!hashLines || !absolutePath || !path.isAbsolute(absolutePath)) return undefined;
	const normalized = normalizeToLF(fullText);
	const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized);
	return {
		header: formatReadHashlineHeader(formatPathRelativeToCwd(absolutePath, session.cwd), tag),
		tag,
		fullText: normalized,
	};
}

export async function readHashlineHeaderContext(
	session: ToolSession,
	absolutePath: string,
): Promise<HashlineHeaderContext> {
	const fullText = await Bun.file(absolutePath).text();
	const context = recordFullHashlineContext(session, true, absolutePath, fullText);
	if (!context) throw new ToolError(`Cannot record hashline snapshot for non-absolute path: ${absolutePath}`);
	return context;
}

export function hashlineHeaderContext(displayPath: string, tag: string): HashlineHeaderContext {
	return { header: formatReadHashlineHeader(displayPath, tag), tag };
}

export function prependHashlineHeader(text: string, context: HashlineHeaderContext | undefined): string {
	return context ? `${context.header}\n${text}` : text;
}

/**
 * What a read shows for a first line wider than the byte budget: the snippet that fits, or a
 * bracketed reason when none can be shown, since a hashline preview needs whole lines and an
 * empty snippet means no valid UTF-8 prefix fit.
 */
export function oversizedFirstLineText(
	lineDisplay: number,
	lineBytes: number,
	budget: number,
	snippet: string,
	hashLines: boolean,
	formatText: (content: string, startNum: number) => string,
): string {
	if (!hashLines) {
		const formatted = formatText(snippet, lineDisplay);
		if (snippet.length > 0) return formatted;
	}
	const reason =
		snippet.length === 0
			? "Unable to display a valid UTF-8 snippet."
			: "Hashline output requires full lines; cannot emit an editable numbered preview for a truncated line.";
	return `[Line ${lineDisplay} is ${formatBytes(lineBytes)}, exceeds ${formatBytes(budget)} limit. ${reason}]`;
}

export function formatTextWithMode(
	text: string,
	startNum: number,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLines(text, startNum);
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}

const BRACKET_CONTEXT_ELLIPSIS = "…";

function formatLineEntryWithMode(entry: LineEntry, shouldAddHashLines: boolean, shouldAddLineNumbers: boolean): string {
	if (entry.kind === "ellipsis") return BRACKET_CONTEXT_ELLIPSIS;
	return formatSingleLine(entry.lineNumber, entry.text, shouldAddHashLines, shouldAddLineNumbers);
}

export function formatLineEntriesWithMode(
	entries: readonly LineEntry[],
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	return entries.map(entry => formatLineEntryWithMode(entry, shouldAddHashLines, shouldAddLineNumbers)).join("\n");
}

export function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

export function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	// Count newlines directly instead of allocating an array via split("\n").
	// Called on every read of file content; the result is identical (N newlines
	// ⇒ N+1 lines for non-empty text).
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

export function lineNumbersFromSpans(spans: readonly { startLine: number; endLine: number }[]): number[] {
	const lines: number[] = [];
	for (const span of spans) {
		for (let line = span.startLine; line <= span.endLine; line++) lines.push(line);
	}
	return lines;
}

export function recordInMemorySeenLines(
	session: ToolSession,
	absolutePath: string | undefined,
	fullText: string,
	seenLines: readonly number[] | undefined,
): void {
	if (!absolutePath || !path.isAbsolute(absolutePath) || !seenLines || seenLines.length === 0) return;
	getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalizeToLF(fullText), seenLines);
}

export function lineNumbersFromEntries(entries: readonly LineEntry[]): number[] {
	const lines: number[] = [];
	for (const entry of entries) {
		if (entry.kind === "line") lines.push(entry.lineNumber);
	}
	return lines;
}

export function entriesDisplay(entries: readonly LineEntry[], fallbackStartLine: number): ReadDisplayContent {
	const text = lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS);
	const first = entries.find(entry => entry.kind === "line");
	const startLine = first?.kind === "line" ? first.lineNumber : fallbackStartLine;
	let contiguous = true;
	for (let i = 0; i < entries.length && contiguous; i++) {
		const entry = entries[i];
		contiguous = entry.kind === "line" && entry.lineNumber === startLine + i;
	}
	if (contiguous) return { text, startLine };
	return { text, startLine, lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)) };
}

/**
 * The display for summary rows numbered `numbers` (`null` for a row that stands for no one line),
 * with the same contract as {@link entriesDisplay}. The list is stored as given, so a caller passes
 * one it no longer uses.
 */
export function numberedDisplay(
	text: string,
	numbers: Array<number | null>,
	fallbackStartLine: number,
): ReadDisplayContent {
	const startLine = numbers.find(number => number !== null) ?? fallbackStartLine;
	let contiguous = true;
	for (let i = 0; i < numbers.length && contiguous; i++) contiguous = numbers[i] === startLine + i;
	if (contiguous) return { text, startLine };
	return { text, startLine, lineNumbers: numbers };
}

/**
 * Column clipping for one displayed selection. Column truncation is display-only: the source
 * lines stay byte-for-byte with the file so the snapshot recorded for hashline edits can be
 * verified against it, and the line numbers clipped here are withheld from the seen-lines record.
 */
export class ColumnClip {
	readonly clippedLines = new Set<number>();
	readonly #displayLineByNumber = new Map<number, string>();
	/** `maxColumns` once any line was clipped, else 0. */
	columnTruncated = 0;

	constructor(readonly maxColumns: number) {}

	/**
	 * `lines` with each one past `maxColumns` clipped, recording the clipped line numbers from
	 * `startLine`; the same array when nothing was clipped.
	 */
	clip(lines: string[], startLine: number): string[] {
		if (this.maxColumns <= 0) return lines;
		let cloned: string[] | undefined;
		for (let i = 0; i < lines.length; i++) {
			const { text, wasTruncated } = truncateLine(lines[i], this.maxColumns);
			if (wasTruncated) {
				if (!cloned) cloned = lines.slice();
				cloned[i] = text;
				this.columnTruncated = this.maxColumns;
				this.clippedLines.add(startLine + i);
			}
		}
		return cloned ?? lines;
	}

	/** Record the display text of `lines` from `startLine`, so `lineText` answers with it. */
	display(lines: string[], startLine: number): void {
		for (let i = 0; i < lines.length; i++) {
			this.#displayLineByNumber.set(startLine + i, lines[i] ?? "");
		}
	}

	/** The text shown for `lineNumber`: its recorded display line, else `sourceText` clipped. */
	readonly lineText = (lineNumber: number, sourceText: string): string => {
		const visibleText = this.#displayLineByNumber.get(lineNumber);
		if (visibleText !== undefined) return visibleText;
		if (this.maxColumns <= 0) return sourceText;
		const truncated = truncateLine(sourceText, this.maxColumns);
		if (truncated.wasTruncated) {
			this.columnTruncated = this.maxColumns;
			this.clippedLines.add(lineNumber);
		}
		return truncated.text;
	};
}

/**
 * Formats the text of one displayed selection in the read's line mode. The hashline header leads
 * the first block formatted and no other, and the last block formatted is the display content the
 * renderer shows.
 */
export class SelectionFormatter {
	displayContent: ReadDisplayContent | undefined;
	readonly #hashLines: boolean;
	readonly #lineNumbers: boolean;
	#header: HashlineHeaderContext | undefined;

	constructor(hashLines: boolean, lineNumbers: boolean, header: HashlineHeaderContext | undefined) {
		this.#hashLines = hashLines;
		this.#lineNumbers = lineNumbers;
		this.#header = header;
	}

	text(text: string, startLine: number): string {
		this.displayContent = { text, startLine };
		return this.#lead(formatTextWithMode(text, startLine, this.#hashLines, this.#lineNumbers));
	}

	entries(entries: readonly LineEntry[], startLine: number): string {
		this.displayContent = entriesDisplay(entries, startLine);
		return this.#lead(formatLineEntriesWithMode(entries, this.#hashLines, this.#lineNumbers));
	}

	#lead(formatted: string): string {
		const header = this.#header;
		if (!header) return formatted;
		this.#header = undefined;
		return prependHashlineHeader(formatted, header);
	}
}
