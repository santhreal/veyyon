/**
 * Small string helpers that belong to no one subsystem.
 *
 * The home for text operations several modules need and none owns. Without one, the
 * next module that needs "first value that is actually set" writes its own — which is
 * how a six-line helper ends up with three spellings that disagree about whether
 * whitespace counts as empty.
 */

/**
 * The first value that is set and not blank, after trimming, or `null`.
 *
 * WHITESPACE IS EMPTY, which is the whole reason to have this rather than `a ?? b`.
 * An env var exported as `TERM=` or a config field left as `"  "` is present and
 * useless; `??` and `||` disagree about those (`??` keeps `""`, `||` drops it but also
 * drops `0`), so code that reaches for either gets one of the two cases wrong.
 *
 * Trimming decides emptiness but does NOT change the answer: the original value is
 * returned trimmed, so a caller cannot get back a string it has to trim again.
 */
export function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

/**
 * Every value that is set and not blank, trimmed, in order.
 *
 * {@link firstNonEmpty} over a whole list rather than the first hit, and the same
 * definition of empty, which is the point of them living together: a codebase with
 * one function for "first non-blank" and a hand-written loop for "all non-blank" has
 * two definitions of blank that can disagree.
 *
 * `gh.ts` wrote this loop twice, 145 lines apart, for a PR identifier list and for
 * search-query fragments. Nothing was wrong with either copy — that is what makes the
 * pattern worth naming, since the next copy is the one that forgets the trim.
 *
 * Duplicates are kept: this answers "which of these are real values", not "which are
 * distinct". A caller that needs uniqueness says so.
 */
export function nonEmptyTrimmed(values: Iterable<string | undefined | null>): string[] {
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}
