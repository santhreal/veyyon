// Single owner of the set-overlap similarity measures used across the package:
// episodic-graph lexical linking, MMR reranking, and the query cache's fuzzy tier all
// compare token sets with the same Jaccard formula. Define it once here so the three
// call sites can never drift on edge cases (empty sets, denominator).

/** Jaccard index of two token sets: |A ∩ B| / |A ∪ B|. Returns 0 when either set is empty. */
export function jaccardIndex(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) {
		if (b.has(item)) intersection += 1;
	}
	return intersection / (a.size + b.size - intersection);
}

/** Max-normalized overlap of two token sets: |A ∩ B| / max(|A|, |B|). Stricter than the
 *  textbook overlap coefficient (which divides by min), it penalizes a size difference.
 *  Returns 0 when either set is empty. */
export function overlapScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const item of a) {
		if (b.has(item)) intersection += 1;
	}
	return intersection / Math.max(a.size, b.size);
}

/** Split text into a lowercased set of whitespace-delimited words; empty tokens are dropped. */
export function wordSet(text: string): Set<string> {
	const words = new Set<string>();
	for (const word of text.toLowerCase().split(/\s+/)) {
		if (word.length !== 0) words.add(word);
	}
	return words;
}

/** Jaccard similarity of two texts compared at the whitespace-word level. */
export function jaccardWordSimilarity(textA: string, textB: string): number {
	return jaccardIndex(wordSet(textA), wordSet(textB));
}
