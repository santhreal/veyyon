/**
 * Memoised native syntax highlighting, and nothing else.
 *
 * WHY IT IS NOT IN `theme.ts`. It was, and it was the only reason that module named
 * `@veyyon/natives` and `lru-cache`. More to the point, `getMarkdownTheme` needed the memoised
 * function too, and `getMarkdownTheme` is what dragged the mermaid renderer into every consumer of a
 * palette: 291 test files import `theme.ts` and paid 36 modules of diagram machinery for a closure
 * most of them never call. Splitting the markdown adapter out needed this to be reachable from both
 * sides, so it moved to the module that owns it.
 *
 * It depends on the ACTIVE theme through `./theme-binding` (one module) rather than on `theme.ts`, so
 * the direction of the edge is highlight -> binding and there is no cycle back into the engine.
 */
import {
	CodeHighlighter,
	type HighlightColors as NativeHighlightColors,
	highlightCode as nativeHighlightCode,
	supportsLanguage as nativeSupportsLanguage,
} from "@veyyon/natives";
// From the modules that own them, not the `@veyyon/utils` barrel: 16 modules against 74, for two
// names. `theme.ts` takes the barrel for other reasons, so this only matters if a cheaper caller ever
// wants the highlighter on its own, which is exactly the position `getMarkdownTheme` was in.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { LRUCache } from "lru-cache/raw";
import { theme } from "./theme-binding";
import type { Theme } from "./theme-class";

let cachedHighlightColorsFor: Theme | undefined;
let cachedHighlightColors: NativeHighlightColors | undefined;

function getHighlightColors(t: Theme): NativeHighlightColors {
	if (cachedHighlightColorsFor !== t || !cachedHighlightColors) {
		cachedHighlightColorsFor = t;
		cachedHighlightColors = {
			comment: t.getFgAnsi("syntaxComment"),
			keyword: t.getFgAnsi("syntaxKeyword"),
			function: t.getFgAnsi("syntaxFunction"),
			variable: t.getFgAnsi("syntaxVariable"),
			string: t.getFgAnsi("syntaxString"),
			number: t.getFgAnsi("syntaxNumber"),
			type: t.getFgAnsi("syntaxType"),
			operator: t.getFgAnsi("syntaxOperator"),
			punctuation: t.getFgAnsi("syntaxPunctuation"),
			inserted: t.getFgAnsi("toolDiffAdded"),
			deleted: t.getFgAnsi("toolDiffRemoved"),
		};
	}
	return cachedHighlightColors;
}

/**
 * Memoized native syntax highlight. Returns the joined ANSI string, or `null`
 * when the native tokenizer throws so callers can apply their own fallback.
 *
 * Keyed on `(lang, code)` and reset whenever the active `theme` instance
 * changes — the ANSI colors are baked into the highlighted output, so a theme
 * switch (which always reassigns `theme`) must invalidate every entry.
 *
 * Why this exists: animated tool blocks (eval/bash) repaint their box on every
 * ~33ms border-shimmer frame, and markdown re-lexes on every streamed delta.
 * Without memoization each frame can re-tokenize an unchanged code body through
 * the Rust FFI — ~26ms for 100 lines, ~40ms for 150 — consuming or overrunning
 * the 33ms frame budget and starving the spinner/render timers (the "TUI freeze").
 */
const HIGHLIGHT_CACHE_MAX = 256;
const highlightCache = new LRUCache<string, string>({ max: HIGHLIGHT_CACHE_MAX });
let highlightCacheTheme: Theme | undefined;

/** Languages already reported as failing to highlight, so the warning below fires once each. */
const reportedHighlightFailures = new Set<string>();

/**
 * Report a highlighter failure once per language.
 *
 * Highlighting failing and a language being unsupported both end as plain text, so without this the
 * difference is invisible: a native highlighter that throws on every Rust block looks exactly like a
 * build with Rust support missing. Bounded to one warning per language because this is a render path.
 */
function reportHighlightFailureOnce(lang: string | undefined, error: unknown): void {
	const key = lang ?? "(no language)";
	if (reportedHighlightFailures.has(key)) return;
	reportedHighlightFailures.add(key);
	logger.warn("Code could not be highlighted; rendering it plain", { lang: key, error: errorMessage(error) });
}

/** Drop every highlighted result when the theme they were coloured in is no longer the one asked for. */
function bindCachesTo(highlightTheme: Theme): void {
	if (highlightCacheTheme === highlightTheme) return;
	highlightCache.clear();
	streams.length = 0;
	highlightCacheTheme = highlightTheme;
}

function highlightCacheKey(code: string, validLang: string | undefined): string {
	return `${validLang ?? ""}\x00${code}`;
}

export function highlightCached(code: string, validLang: string | undefined, highlightTheme: Theme): string | null {
	bindCachesTo(highlightTheme);
	const key = highlightCacheKey(code, validLang);
	const hit = highlightCache.get(key);
	if (hit !== undefined) {
		return hit;
	}
	let highlighted: string;
	try {
		highlighted = nativeHighlightCode(code, validLang, getHighlightColors(highlightTheme));
	} catch (error) {
		// Null means "render this code plain", which is also what an unsupported language gets, so a
		// highlighter that is actually FAILING looked like a language nobody supports. Reported once per
		// language: this runs per code block, and a warning per frame would be its own bug.
		reportHighlightFailureOnce(validLang, error);
		return null;
	}
	highlightCache.set(key, highlighted);
	return highlighted;
}

/**
 * A source highlighted as it grows.
 *
 * A streaming card redraws on every argument delta, and the source it draws is the one it drew last
 * with more appended. Highlighting the whole source on each redraw is quadratic in the file: a
 * 600-line write spent 67ms of every frame in the highlighter by its last line. A stream keeps the
 * native parser where its last whole line left it, so a redraw highlights the lines that arrived
 * and the unfinished last line, and the rows are byte-identical to highlighting the whole source.
 */
interface HighlightStream {
	readonly lang: string | undefined;
	readonly highlighter: CodeHighlighter;
	/** The whole lines highlighted so far, each ending in a newline. */
	settled: string;
	/** One highlighted row per line of `settled`. */
	readonly rows: string[];
	/**
	 * The highlighted text after the last newline of `settled`: the colour reset of a token that ran
	 * through the line end, which opens the next row.
	 */
	carry: string;
	/** The unfinished last line the stream last highlighted, or `undefined` once more lines settle. */
	partial: string | undefined;
	/** The highlighted row of `partial`. */
	partialRow: string;
}

/**
 * The streams kept, most recently used first. Several cards can stream at once, and a card that
 * pauses while another draws keeps its place, but every entry holds a source and its rows.
 */
const STREAMS_MAX = 8;
const streams: HighlightStream[] = [];

function countNewlines(text: string): number {
	let count = 0;
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
	return count;
}

/**
 * The stream whose settled lines are the longest prefix of `code`.
 *
 * A stream with no settled line is a prefix of every source, so it would take over the next unrelated
 * block and highlight it whole in place of that block's cached rows. It is never continued.
 */
function findStream(code: string, validLang: string | undefined): HighlightStream | undefined {
	let best: HighlightStream | undefined;
	for (const stream of streams) {
		if (stream.lang !== validLang || stream.settled.length === 0) continue;
		if (best !== undefined && stream.settled.length <= best.settled.length) continue;
		if (code.startsWith(stream.settled)) best = stream;
	}
	return best;
}

/**
 * The rows of `code`, highlighted from where `stream` stopped, or `undefined` when the highlighter
 * returned a different number of lines than it was given, which leaves the stream unusable.
 */
function extendStream(stream: HighlightStream, code: string): string[] | undefined {
	const settledEnd = code.lastIndexOf("\n") + 1;
	if (settledEnd > stream.settled.length) {
		const arrived = code.slice(stream.settled.length, settledEnd);
		const rows = `${stream.carry}${stream.highlighter.advance(arrived)}`.split("\n");
		if (rows.length !== countNewlines(arrived) + 1) return undefined;
		stream.carry = rows.pop() ?? "";
		for (const row of rows) stream.rows.push(row);
		stream.settled = code.slice(0, settledEnd);
		stream.partial = undefined;
	}
	const partial = code.slice(settledEnd);
	if (stream.partial !== partial) {
		const row = `${stream.carry}${stream.highlighter.peek(partial)}`;
		if (row.includes("\n")) return undefined;
		stream.partial = partial;
		stream.partialRow = row;
	}
	return [...stream.rows, stream.partialRow];
}

/**
 * Highlighted rows of `code`: extended from a stream it continues, else the exact cache, else a new
 * stream. `undefined` when the highlighter failed, which is reported once per language.
 */
function highlightRows(code: string, validLang: string | undefined, highlightTheme: Theme): string[] | undefined {
	bindCachesTo(highlightTheme);
	const continued = findStream(code, validLang);
	if (continued !== undefined) {
		streams.splice(streams.indexOf(continued), 1);
		const rows = extendStreamReporting(continued, code);
		if (rows !== undefined) {
			streams.unshift(continued);
			return rows;
		}
	}
	const key = highlightCacheKey(code, validLang);
	const hit = highlightCache.get(key);
	if (hit !== undefined) {
		const rows = hit.split("\n");
		return rows.length === countNewlines(code) + 1 ? rows : undefined;
	}
	let highlighter: CodeHighlighter;
	try {
		highlighter = new CodeHighlighter(validLang, getHighlightColors(highlightTheme));
	} catch (error) {
		reportHighlightFailureOnce(validLang, error);
		return undefined;
	}
	const stream: HighlightStream = {
		lang: validLang,
		highlighter,
		settled: "",
		rows: [],
		carry: "",
		partial: undefined,
		partialRow: "",
	};
	const rows = extendStreamReporting(stream, code);
	if (rows === undefined) return undefined;
	// A stream with no whole line is never continued (see `findStream`), so keeping it would only
	// push out one that is.
	if (stream.settled.length > 0) {
		streams.unshift(stream);
		if (streams.length > STREAMS_MAX) streams.length = STREAMS_MAX;
	}
	highlightCache.set(key, rows.join("\n"));
	return rows;
}

function extendStreamReporting(stream: HighlightStream, code: string): string[] | undefined {
	try {
		return extendStream(stream, code);
	} catch (error) {
		reportHighlightFailureOnce(stream.lang, error);
		return undefined;
	}
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string, highlightTheme: Theme = theme): string[] {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	// A highlighter only styles tokens inline — it must never change the source
	// line count. If it did (invalid UTF-16 like a lone surrogate is mangled
	// crossing the native UTF-8 boundary and can drop lines), the styled output
	// is untrustworthy: fall back to the raw code so the block renders complete
	// rather than silently missing lines. The rows are always a fresh array:
	// callers (e.g. renderCodeCell) push extra lines onto the result.
	return highlightRows(code, validLang, highlightTheme) ?? code.split("\n");
}
