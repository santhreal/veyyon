import { clampLow } from "./math";

/**
 * Levenshtein edit distance over UTF-16 code units (two-row DP, O(min) memory).
 *
 * Code-unit granularity means an astral character (emoji, surrogate pair)
 * counts as two units; for typo detection and fuzzy text matching this is the
 * right speed/precision trade — hot paths (edit-tool fuzzy match) call this in
 * tight loops.
 */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

/**
 * Edit distance that counts a transposition as ONE edit (Damerau-Levenshtein).
 *
 * The metric for typo suggestion, and the reason it is separate from
 * {@link levenshteinDistance}: the typos a person makes are overwhelmingly
 * transpositions (`raed` for `read`, `wriet` for `write`), and plain
 * Levenshtein charges a swap two edits, which puts it outside any budget tight
 * enough to be useful on a short name. Suggestion quality collapses without
 * this.
 *
 * The two metrics are both kept on purpose. {@link levenshteinDistance} is the
 * edit tool's fuzzy-match hot path, where the number feeds an acceptance
 * threshold rather than a message, and it uses two-row DP for O(min) memory.
 * This one allocates a full matrix, because the adjacent-transposition rule
 * needs to look two rows back. Do not merge them: one is a matching decision,
 * the other is a suggestion.
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
	const rows: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = 0; i <= a.length; i++) rows[i]![0] = i;
	for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, rows[i - 2]![j - 2]! + 1);
			}
			rows[i]![j] = best;
		}
	}
	return rows[a.length]![b.length]!;
}

/**
 * Candidate names close enough to `typed` to be worth suggesting, best first.
 *
 * The one owner of "what did they probably mean?". Every surface that rejects a
 * name a human typed wants to answer that question, and each one deriving its
 * own threshold is how they disagree: a key that earns a suggestion from the
 * config CLI and silence from a rule loader, for no reason anyone chose.
 *
 * Matching is case-insensitive and runs in three tiers, so a certain answer is
 * never buried under a merely plausible one: an exact match, then a substring
 * containment, then edit distance. Within the distance tier, closer wins and
 * ties break alphabetically, so the same input always produces the same list.
 *
 * Distance is {@link damerauLevenshteinDistance}, so a transposition costs one
 * edit rather than two. That matters more than it sounds: `raed` for `read` is
 * the single most common way a short name is mistyped, and under plain
 * Levenshtein it sits outside every budget tight enough to be useful.
 *
 * The distance budget scales with the input. One edit in a four-character name
 * is a typo; one edit in a thirty-character path could be a genuinely different
 * name, so longer inputs get a little more room and never more than three,
 * which is the point where suggestions become noise a reader has to filter.
 *
 * Returns at most `limit` names, deduplicated across tiers.
 */
export function nearestNames(typed: string, candidates: Iterable<string>, limit = 5): string[] {
	const needle = typed.trim().toLowerCase();
	if (needle.length === 0) return [];

	const all = [...candidates];
	const out: string[] = [];
	const seen = new Set<string>();
	const take = (names: readonly string[]): void => {
		for (const name of names) {
			if (out.length >= limit) return;
			if (seen.has(name)) continue;
			seen.add(name);
			out.push(name);
		}
	};

	take(all.filter(name => name.toLowerCase() === needle));
	take(all.filter(name => name.toLowerCase().includes(needle)));
	const budget = clampLow(Math.floor(needle.length / 4), 1, 3);
	take(
		all
			.map(name => ({ name, distance: damerauLevenshteinDistance(needle, name.toLowerCase()) }))
			.filter(entry => entry.distance <= budget)
			.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
			.map(entry => entry.name),
	);
	return out;
}
