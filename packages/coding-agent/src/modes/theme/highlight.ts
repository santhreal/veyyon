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

export function highlightCached(code: string, validLang: string | undefined, highlightTheme: Theme): string | null {
	if (highlightCacheTheme !== highlightTheme) {
		highlightCache.clear();
		highlightCacheTheme = highlightTheme;
	}
	const key = `${validLang ?? ""}\x00${code}`;
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
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string, highlightTheme: Theme = theme): string[] {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	const highlighted = highlightCached(code, validLang, highlightTheme);
	// Always return a fresh array: callers (e.g. renderCodeCell) push extra lines
	// onto the result, which would corrupt the cached string otherwise.
	const lines = (highlighted ?? code).split("\n");
	// A highlighter only styles tokens inline — it must never change the source
	// line count. If it did (invalid UTF-16 like a lone surrogate is mangled
	// crossing the native UTF-8 boundary and can drop lines), the styled output
	// is untrustworthy: fall back to the raw code so the block renders complete
	// rather than silently missing lines.
	const rawLines = code.split("\n");
	return lines.length === rawLines.length ? lines : rawLines;
}
