import { enclosingBlockBoundaries } from "@veyyon/natives";
// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import * as logger from "@veyyon/utils/logger";

export interface LineSpan {
	startLine: number;
	endLine: number;
}

/**
 * Where the source came from, so tree-sitter can pick a grammar.
 *
 * `text` is the same source `fullLines` was split from, when the caller still has it. The
 * native side needs one string, and rebuilding it with `join` allocates the whole file a
 * second time -- 3.5MiB per read on a 100k-line file whose caller had just read it.
 */
export interface BlockContextSource {
	path?: string;
	lang?: string;
	text?: string;
}

export type LineEntry = { kind: "line"; lineNumber: number; text: string; context: boolean } | { kind: "ellipsis" };

/** An unmatched opening bracket: its own code unit, and the line it opened on. */
interface StackEntry {
	opener: number;
	lineNumber: number;
	text: string;
	visible: boolean;
}

type QuotedMode = "single" | "double" | "template";
type ScannerMode = "code" | QuotedMode | "blockComment";

/** The UTF-16 code units the lexical scan acts on. */
const SLASH = 0x2f;
const STAR = 0x2a;
const HASH = 0x23;
const SPACE = 0x20;
const TAB = 0x09;
const BACKSLASH = 0x5c;
const SINGLE_QUOTE = 0x27;
const DOUBLE_QUOTE = 0x22;
const BACKTICK = 0x60;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const OPEN_SQUARE = 0x5b;
const CLOSE_SQUARE = 0x5d;
const OPEN_CURLY = 0x7b;
const CLOSE_CURLY = 0x7d;

const CLOSING_QUOTE: Record<QuotedMode, number> = {
	single: SINGLE_QUOTE,
	double: DOUBLE_QUOTE,
	template: BACKTICK,
};

/** Lexical scan state carried from one line to the next. */
interface BracketScan {
	mode: ScannerMode;
	escaped: boolean;
	readonly stack: StackEntry[];
	readonly context: Map<number, string>;
}

function normalizeLineSpans(spans: readonly LineSpan[], totalLines: number): LineSpan[] {
	if (totalLines <= 0) return [];
	const normalized: LineSpan[] = [];
	for (const span of spans) {
		const startLine = Math.max(1, Math.trunc(span.startLine));
		const endLine = Math.min(totalLines, Math.trunc(span.endLine));
		if (endLine < startLine) continue;
		normalized.push({ startLine, endLine });
	}
	if (normalized.length <= 1) return normalized;
	normalized.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: LineSpan[] = [];
	for (const span of normalized) {
		const previous = merged[merged.length - 1];
		if (previous && span.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, span.endLine);
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}

function visibleLineNumbers(spans: readonly LineSpan[]): Set<number> {
	const visible = new Set<number>();
	for (const span of spans) {
		for (let line = span.startLine; line <= span.endLine; line++) {
			visible.add(line);
		}
	}
	return visible;
}

function hasEveryLineVisible(visible: ReadonlySet<number>, totalLines: number): boolean {
	return totalLines > 0 && visible.size >= totalLines;
}

/**
 * Ceiling on the source a boundary lookup will scan, in bytes. It mirrors
 * `MAX_CACHED_BYTES` in `natives/code/ast/src/parse_cache.rs`: below it the
 * parse cache retains the tree (and serves a source one edit away by editing
 * it), so a second lookup on the same file is nearly free; above it nothing is
 * retained and every lookup pays a whole-file parse. A streamed edit preview
 * asks twice per redraw — the file on disk, then the file the edit produces —
 * so on a 11.7MiB source that was 1.9s of tree-sitter per redraw for at most
 * two boundary rows, and the redraw rate collapsed to the parse rate. Past the
 * ceiling the diff and the read window render without off-window boundary rows
 * instead of paying for them.
 */
const SCAN_CEILING_BYTES = 4 * 1024 * 1024;

/**
 * Whether the source is too large for a boundary lookup to scan. Sizing is
 * exact against {@link SCAN_CEILING_BYTES} when the caller kept the source
 * string; without it, summing line lengths is a lower bound on the byte count
 * (one UTF-16 unit is at least one UTF-8 byte), so a source over the ceiling in
 * units is over it in bytes, and anything at or below falls through to the
 * lookup as before.
 */
function exceedsScanCeiling(fullLines: readonly string[], source: BlockContextSource): boolean {
	const text = source.text;
	if (text !== undefined) {
		// A character count is checked first because it is free: it can only
		// undercount bytes, so a source over the ceiling in characters needs no
		// byte pass, and one well under it needs no byte pass either.
		if (text.length > SCAN_CEILING_BYTES) return true;
		if (text.length <= SCAN_CEILING_BYTES / 4) return false;
		return Buffer.byteLength(text) > SCAN_CEILING_BYTES;
	}
	let units = fullLines.length > 0 ? fullLines.length - 1 : 0;
	for (const line of fullLines) {
		units += line.length;
		if (units > SCAN_CEILING_BYTES) return true;
	}
	return false;
}

/**
 * Whether a boundary lookup on this source would be refused for its size, for
 * a caller that would otherwise build the line arrays a lookup needs. A
 * unified diff splits both sides of the pair to map boundary rows onto line
 * numbers, which is two whole-file arrays per redraw for an answer the ceiling
 * already decided.
 */
export function exceedsBlockContextScanCeiling(text: string): boolean {
	return exceedsScanCeiling([], { text });
}

/** Collapse a set of visible line numbers into sorted, merged inclusive spans. */
function visibleSetToSpans(visible: ReadonlySet<number>): LineSpan[] {
	const sorted = Array.from(visible).sort((left, right) => left - right);
	const spans: LineSpan[] = [];
	for (const line of sorted) {
		const previous = spans[spans.length - 1];
		if (previous && line <= previous.endLine + 1) {
			previous.endLine = line;
			continue;
		}
		spans.push({ startLine: line, endLine: line });
	}
	return spans;
}

/**
 * Tree-sitter-backed block boundaries. For each multi-line named node whose
 * span crosses the visible window, the native side returns the boundary line
 * outside that window (closer when the opener is shown, opener when the closer
 * is shown). Returns `null` when the language is unrecognized or the source has
 * a syntax error so the caller can fall back to a lexical bracket scan.
 */
function nativeBlockContext(
	fullLines: readonly string[],
	visible: ReadonlySet<number>,
	source: BlockContextSource,
): Map<number, string> | null {
	if (!source.path && !source.lang) return null;
	const ranges = visibleSetToSpans(visible);
	if (ranges.length === 0) return new Map();
	let boundaries: number[] | null;
	try {
		boundaries = enclosingBlockBoundaries({
			code: source.text ?? fullLines.join("\n"),
			path: source.path,
			lang: source.lang,
			ranges,
		});
	} catch (error) {
		logger.debug("enclosingBlockBoundaries failed; using lexical bracket fallback", { error });
		return null;
	}
	if (boundaries === null) return null;
	const context = new Map<number, string>();
	for (const lineNumber of boundaries) {
		if (visible.has(lineNumber)) continue;
		context.set(lineNumber, fullLines[lineNumber - 1] ?? "");
	}
	return context;
}

/** Whether only spaces and tabs precede `index`, which makes a `#` there a line comment. */
function onlyBlanksBefore(line: string, index: number): boolean {
	for (let i = 0; i < index; i++) {
		const code = line.charCodeAt(i);
		if (code !== SPACE && code !== TAB) return false;
	}
	return true;
}

/**
 * Pair a closing bracket with the nearest open `opener`, dropping every bracket opened after it,
 * and record the endpoint that sits outside the visible window. A closer with no opener is ignored.
 */
function closeBracket(scan: BracketScan, opener: number, lineNumber: number, line: string, lineVisible: boolean): void {
	const stack = scan.stack;
	for (let at = stack.length - 1; at >= 0; at--) {
		const matched = stack[at];
		if (matched.opener !== opener) continue;
		stack.length = at;
		if (lineVisible && !matched.visible) scan.context.set(matched.lineNumber, matched.text);
		if (matched.visible && !lineVisible) scan.context.set(lineNumber, line);
		return;
	}
}

/** Open a string. `escaped` is already false: code is only reached past an unescaped closing quote or a line end. */
function openQuoted(scan: BracketScan, mode: QuotedMode, index: number): number {
	scan.mode = mode;
	return index;
}

/**
 * Scan code from `index` until the line ends or a string or block comment opens, pairing brackets
 * on the way. Returns where the scan stopped; a line comment stops it at the line's end.
 */
function scanCode(line: string, index: number, lineNumber: number, lineVisible: boolean, scan: BracketScan): number {
	while (index < line.length) {
		const code = line.charCodeAt(index++);
		switch (code) {
			case SLASH: {
				const next = line.charCodeAt(index);
				if (next === SLASH) return line.length;
				if (next === STAR) {
					scan.mode = "blockComment";
					return index + 1;
				}
				break;
			}
			case HASH:
				if (onlyBlanksBefore(line, index - 1)) return line.length;
				break;
			case SINGLE_QUOTE:
				return openQuoted(scan, "single", index);
			case DOUBLE_QUOTE:
				return openQuoted(scan, "double", index);
			case BACKTICK:
				return openQuoted(scan, "template", index);
			case OPEN_PAREN:
			case OPEN_SQUARE:
			case OPEN_CURLY:
				scan.stack.push({ opener: code, lineNumber, text: line, visible: lineVisible });
				break;
			case CLOSE_PAREN:
				closeBracket(scan, OPEN_PAREN, lineNumber, line, lineVisible);
				break;
			case CLOSE_SQUARE:
				closeBracket(scan, OPEN_SQUARE, lineNumber, line, lineVisible);
				break;
			case CLOSE_CURLY:
				closeBracket(scan, OPEN_CURLY, lineNumber, line, lineVisible);
				break;
		}
	}
	return index;
}

/** Skip a string body from `index` to just past its closing quote, honoring backslash escapes. */
function skipQuoted(line: string, index: number, scan: BracketScan, quote: number): number {
	while (index < line.length) {
		const code = line.charCodeAt(index++);
		if (scan.escaped) {
			scan.escaped = false;
		} else if (code === BACKSLASH) {
			scan.escaped = true;
		} else if (code === quote) {
			scan.mode = "code";
			return index;
		}
	}
	return index;
}

/** Skip a block comment body from `index` to just past its `*\/`, or to the line's end. */
function skipBlockComment(line: string, index: number, scan: BracketScan): number {
	const end = line.indexOf("*/", index);
	if (end === -1) return line.length;
	scan.mode = "code";
	return end + 2;
}

function scanLine(line: string, lineNumber: number, lineVisible: boolean, scan: BracketScan): void {
	let index = 0;
	while (index < line.length) {
		const mode = scan.mode;
		if (mode === "code") index = scanCode(line, index, lineNumber, lineVisible, scan);
		else if (mode === "blockComment") index = skipBlockComment(line, index, scan);
		else index = skipQuoted(line, index, scan, CLOSING_QUOTE[mode]);
	}
	// A quoted string ends with its line; a template literal and a block comment run on.
	if (scan.mode === "single" || scan.mode === "double") {
		scan.mode = "code";
		scan.escaped = false;
	}
}

/**
 * Lexical bracket-matching fallback for sources tree-sitter can't parse
 * (unknown extensions, syntax errors). Pairs `()[]{}` while skipping strings
 * and line/block comments, and reports the matching line when one endpoint is
 * visible and the other is not. Only the hidden endpoint is recorded, so no
 * visible line is ever in the result.
 */
function lexicalBracketContext(fullLines: readonly string[], visible: ReadonlySet<number>): Map<number, string> {
	const scan: BracketScan = { mode: "code", escaped: false, stack: [], context: new Map() };
	for (let lineIndex = 0; lineIndex < fullLines.length; lineIndex++) {
		const lineNumber = lineIndex + 1;
		scanLine(fullLines[lineIndex] ?? "", lineNumber, visible.has(lineNumber), scan);
	}
	return scan.context;
}

/**
 * Resolve the off-window boundary lines for a visible window: tree-sitter
 * syntactic spans first (covers brace and indentation languages), falling back
 * to a lexical bracket scan when the grammar is unavailable. Returns a map of
 * `lineNumber → source text` for the lines to surface, never including a line
 * already visible. A source over {@link SCAN_CEILING_BYTES} resolves to no
 * boundary lines: both backends scan the whole source, and past that size
 * nothing retains the result, so the scan would be paid again on every redraw.
 */
export function findBlockContextLines(
	fullLines: readonly string[],
	visibleInput: ReadonlySet<number> | readonly number[],
	source: BlockContextSource = {},
): Map<number, string> {
	const visible = visibleInput instanceof Set ? visibleInput : new Set(visibleInput);
	if (visible.size === 0 || hasEveryLineVisible(visible, fullLines.length)) return new Map();
	if (exceedsScanCeiling(fullLines, source)) return new Map();
	return nativeBlockContext(fullLines, visible, source) ?? lexicalBracketContext(fullLines, visible);
}

/**
 * Build display entries for `visibleSpans` plus any off-window block-boundary
 * lines, in source order, with `{ kind: "ellipsis" }` markers inserted across
 * non-contiguous gaps. `options.lineText` lets callers substitute display text
 * (e.g. column-truncated lines) for a given line number.
 */
export function buildLineEntriesWithBlockContext(
	fullLines: readonly string[],
	visibleSpans: readonly LineSpan[],
	source: BlockContextSource = {},
	options: {
		lineText?: (lineNumber: number, sourceText: string, context: boolean) => string;
	} = {},
): LineEntry[] {
	const spans = normalizeLineSpans(visibleSpans, fullLines.length);
	const visible = visibleLineNumbers(spans);
	const context = findBlockContextLines(fullLines, visible, source);
	const allLines = new Set<number>(visible);
	for (const lineNumber of context.keys()) allLines.add(lineNumber);

	const sorted = Array.from(allLines).sort((left, right) => left - right);
	const entries: LineEntry[] = [];
	let previousLine: number | undefined;
	for (const lineNumber of sorted) {
		if (previousLine !== undefined && lineNumber > previousLine + 1) {
			entries.push({ kind: "ellipsis" });
		}
		const sourceText = fullLines[lineNumber - 1] ?? "";
		const isContext = context.has(lineNumber);
		entries.push({
			kind: "line",
			lineNumber,
			text: options.lineText?.(lineNumber, sourceText, isContext) ?? sourceText,
			context: isContext,
		});
		previousLine = lineNumber;
	}

	return entries;
}

export function lineEntriesToPlainText(entries: readonly LineEntry[], ellipsis = "…"): string {
	return entries.map(entry => (entry.kind === "ellipsis" ? ellipsis : entry.text)).join("\n");
}
