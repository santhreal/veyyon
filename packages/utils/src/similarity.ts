/**
 * Jaccard similarity of two string sets: |A ∩ B| / |A ∪ B|.
 *
 * Returns 0 when either set is empty. Iterates the smaller set.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [small, large] = a.size < b.size ? [a, b] : [b, a];
	let intersection = 0;
	for (const x of small) {
		if (large.has(x)) intersection++;
	}
	return intersection / (a.size + b.size - intersection);
}
