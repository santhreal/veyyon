/** Memoised native syntax highlighting, and nothing else. `@veyyon/natives` and `lru-cache`. More to the point, `getMarkdownTheme` needed the memoised */
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

/** Memoized native syntax highlight. Returns the joined ANSI string, or `null` when the native tokenizer throws so callers can apply their own fallback. */
const HIGHLIGHT_CACHE_MAX = 256;
// Nested by language so the cache key is the code string itself, not a `${lang}\x00${code}` concatenation that copies the entire code body on
const highlightLangCaches = new Map<string, LRUCache<string, string>>();
let highlightCacheTheme: Theme | undefined;

/** Languages already reported as failing to highlight, so the warning below fires once each. */
const reportedHighlightFailures = new Set<string>();

/** Report a highlighter failure once per language. Highlighting failing and a language being unsupported both end as plain text, so without this the */
function reportHighlightFailureOnce(lang: string | undefined, error: unknown): void {
	const key = lang ?? "(no language)";
	if (reportedHighlightFailures.has(key)) return;
	reportedHighlightFailures.add(key);
	logger.warn("Code could not be highlighted; rendering it plain", { lang: key, error: errorMessage(error) });
}

export function highlightCached(code: string, validLang: string | undefined, highlightTheme: Theme): string | null {
	if (highlightCacheTheme !== highlightTheme) {
		highlightLangCaches.clear();
		highlightCacheTheme = highlightTheme;
	}
	const langKey = validLang ?? "";
	let cache = highlightLangCaches.get(langKey);
	if (cache === undefined) {
		cache = new LRUCache<string, string>({ max: HIGHLIGHT_CACHE_MAX });
		highlightLangCaches.set(langKey, cache);
	}
	const hit = cache.get(code);
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
	cache.set(code, highlighted);
	return highlighted;
}

/** Highlight code with syntax coloring based on file extension or language. Returns array of highlighted lines. */
export function highlightCode(code: string, lang?: string, highlightTheme: Theme = theme): string[] {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	const highlighted = highlightCached(code, validLang, highlightTheme);
	// Always return a fresh array: callers (e.g. renderCodeCell) push extra lines
	// onto the result, which would corrupt the cached string otherwise.
	const lines = (highlighted ?? code).split("\n");
	// A highlighter only styles tokens inline — it must never change the source line count. If it did (invalid UTF-16 like a lone surrogate is mangled
	let rawLineCount = 1;
	for (let i = 0; i < code.length; i++) {
		if (code.charCodeAt(i) === 0x0a) rawLineCount++;
	}
	return lines.length === rawLineCount ? lines : code.split("\n");
}
