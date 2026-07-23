/**
 * Anchor selection for the large-base scale suites (`apply-edits-past-6000-*`).
 *
 * Every one of those suites exercises a single-line edit (INS.POST / INS.PRE /
 * DEL / SWAP / header round-trip) at anchor `a` for a base of `n` lines. Each
 * `applyEdits` call rebuilds the whole base, so it is O(n). Sweeping all `n`
 * anchors is therefore O(n^2): at n=100000 that is ~10^10 operations, which
 * blows both bun's 5s per-test timeout and the ci-test-ts 600s bucket watchdog
 * (a SIGKILL reported as exit 137). It also buys no extra contract — the
 * placement logic is identical at every interior anchor, so the tail anchors
 * add cost without adding a distinct assertion.
 *
 * `sweepAnchors` keeps the exhaustive sweep where it is cheap and meaningful
 * (small bases) and drops to a bounded, deterministic sample on large bases:
 * both ends, the anchors adjacent to each end (the off-by-one boundaries that
 * actually catch bugs), and evenly spaced interior anchors. The sample still
 * proves the edit lands correctly at large n; it just does not re-prove the
 * uniform interior 100000 times.
 */

/** Bases at or below this size are swept exhaustively; larger bases are sampled. */
export const EXHAUSTIVE_MAX = 4000;

/** Number of evenly spaced interior probes taken on a large (sampled) base. */
export const INTERIOR_SAMPLES = 60;

/**
 * The 1-based anchors to exercise for a base of `n` lines: `1..n` in full when
 * `n <= EXHAUSTIVE_MAX`, otherwise a bounded sorted sample (both ends, their
 * adjacent boundaries, and `INTERIOR_SAMPLES` evenly spaced interior anchors).
 */
export function sweepAnchors(n: number): number[] {
	if (n <= 0) {
		return [];
	}
	if (n <= EXHAUSTIVE_MAX) {
		return Array.from({ length: n }, (_, i) => i + 1);
	}
	const picks = new Set<number>();
	// Both ends and the anchors just inside them: the boundaries where off-by-one
	// bugs live.
	for (const a of [1, 2, 3, n - 2, n - 1, n]) {
		if (a >= 1 && a <= n) {
			picks.add(a);
		}
	}
	// Evenly spaced interior anchors so the sample tracks the whole range, not
	// just its ends.
	for (let step = 1; step < INTERIOR_SAMPLES; step++) {
		const a = Math.round((step * n) / INTERIOR_SAMPLES);
		if (a >= 1 && a <= n) {
			picks.add(a);
		}
	}
	return [...picks].sort((a, b) => a - b);
}
