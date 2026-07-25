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
 * How many results a search provider returns when the caller does not say.
 *
 * One value, one place. It was written out as a private `DEFAULT_NUM_RESULTS = 10` in
 * fifteen provider files, so changing what the agent asks for by default meant fifteen
 * edits — and, worse, a reader could not tell the fifteen copies apart from the two
 * providers that deviate on purpose. Deviating is allowed; doing it silently is not, so a
 * provider that wants a different default declares its own constant with a comment saying
 * why, and everything else imports this.
 *
 * Ten is a page of results: enough for the model to find the answer without spending a
 * large fraction of the context window on links it will not open. It is not the MAXIMUM,
 * which is per-provider (their APIs cap differently) and passed to {@link clampNumResults}
 * alongside this.
 */
export const SEARCH_DEFAULT_NUM_RESULTS = 10;

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
