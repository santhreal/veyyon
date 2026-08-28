// `collapseWhitespace` now lives in @veyyon/utils as the repo-wide owner of the collapse-and-trim idiom; re-exported here so the HTML-scraping providers keep importing it from `../utils` unchanged. From
export { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";

/** Calculate age in seconds from an ISO date string. Returns undefined on invalid input. */
export function dateToAgeSeconds(dateStr: string | null | undefined): number | undefined {
	if (!dateStr) return undefined;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return undefined;
		return Math.floor((Date.now() - date.getTime()) / 1000);
	} catch {
		return undefined;
	}
}

/** How many results a search provider returns when the caller does not say. One value, one place. It was written out as a private `DEFAULT_NUM_RESULTS = 10` in */
export const SEARCH_DEFAULT_NUM_RESULTS = 10;

/** Clamp a result count to the integer range [1, maxVal], returning defaultVal when value is absent, zero, or NaN. A result count is always a whole number, */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.floor(Math.min(maxVal, Math.max(1, value)));
}

/** Sanitize a caller-supplied result limit for providers that impose NO default cap: they return whatever the upstream API/grounding gave unless an explicit */
export function sanitizeResultLimit(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value < 1) return undefined;
	return Math.floor(value);
}

/** Apply a caller-supplied result limit to a list of sources for the no-default providers (anthropic, codex, jina, synthetic). This is the single owner of the */
export function applyResultLimit<T>(sources: T[], rawLimit: number | undefined): T[] {
	const limit = sanitizeResultLimit(rawLimit);
	if (limit === undefined || sources.length <= limit) return sources;
	return sources.slice(0, limit);
}
