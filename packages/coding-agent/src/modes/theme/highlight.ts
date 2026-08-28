import {
	type HighlightColors as NativeHighlightColors,
	highlightCode as nativeHighlightCode,
	supportsLanguage as nativeSupportsLanguage,
} from "@veyyon/natives";
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

const HIGHLIGHT_CACHE_MAX = 256;
const highlightLangCaches = new Map<string, LRUCache<string, string>>();
let highlightCacheTheme: Theme | undefined;

const reportedHighlightFailures = new Set<string>();

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
		reportHighlightFailureOnce(validLang, error);
		return null;
	}
	cache.set(code, highlighted);
	return highlighted;
}

export function highlightCode(code: string, lang?: string, highlightTheme: Theme = theme): string[] {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	const highlighted = highlightCached(code, validLang, highlightTheme);
	const lines = (highlighted ?? code).split("\n");
	let rawLineCount = 1;
	for (let i = 0; i < code.length; i++) {
		if (code.charCodeAt(i) === 0x0a) rawLineCount++;
	}
	return lines.length === rawLineCount ? lines : code.split("\n");
}
