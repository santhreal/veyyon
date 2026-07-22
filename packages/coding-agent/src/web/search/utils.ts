// `collapseWhitespace` now lives in @veyyon/utils as the repo-wide owner of the
// collapse-and-trim idiom; re-exported here so the HTML-scraping providers keep
// importing it from `../utils` unchanged.
export { collapseWhitespace } from "@veyyon/utils";

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

/**
 * Clamp a result count to the integer range [1, maxVal], returning defaultVal
 * when value is absent, zero, or NaN. A result count is always a whole number,
 * so a fractional input is floored: every provider hands the result straight to
 * a search API as `count`/`limit`/`numResults`, and a non-integer there is
 * invalid. Integer inputs (the only ones callers pass today) are unaffected.
 */
export function clampNumResults(value: number | undefined, defaultVal: number, maxVal: number): number {
	if (!value || Number.isNaN(value)) return defaultVal;
	return Math.floor(Math.min(maxVal, Math.max(1, value)));
}

/**
 * Sanitize a caller-supplied result limit for providers that impose NO default
 * cap: they return whatever the upstream API/grounding gave unless an explicit
 * positive limit is set. Unlike {@link clampNumResults} there is no default and
 * no maximum, so an absent limit must stay absent (return everything).
 *
 * A limit that is not a finite number of at least 1 (undefined, NaN, Infinity,
 * zero, negative, or below one) is treated as "no explicit limit" and returns
 * undefined; a valid limit is floored to a whole count. This is the single owner
 * of the "cap only when a real positive limit is given" rule, and it closes a
 * silent bug: a negative limit reached `Array.prototype.slice(0, negative)` and
 * dropped results from the END of the list instead of capping the front.
 */
export function sanitizeResultLimit(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value) || value < 1) return undefined;
	return Math.floor(value);
}

/**
 * Apply a caller-supplied result limit to a list of sources for the no-default
 * providers (anthropic, codex, jina, synthetic). This is the single owner of the
 * "cap only when a real positive limit is given, otherwise return everything"
 * rule as it applies to a source LIST: it runs {@link sanitizeResultLimit} on the
 * raw value, returns the list unchanged (same reference, no needless copy) when
 * there is no cap or the list is already within it, and otherwise slices the
 * front. Before this owner existed the four providers each re-expressed the rule
 * inline (two as a ternary, two as a length-guarded `if`), free to drift.
 */
export function applyResultLimit<T>(sources: T[], rawLimit: number | undefined): T[] {
	const limit = sanitizeResultLimit(rawLimit);
	if (limit === undefined || sources.length <= limit) return sources;
	return sources.slice(0, limit);
}
