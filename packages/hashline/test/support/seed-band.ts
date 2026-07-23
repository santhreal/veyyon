/**
 * Seed selection for the `apply-edits-past-6000-seeds-*` fuzz-walk suites.
 *
 * Each of those 114 suites drives a seeded pseudo-random walk of INS/DEL/SWAP
 * operations over a tiny base and asserts the walk never throws and always
 * yields a string — a crash-fuzz over ~3,000,000 seeds in total. Running every
 * seed on every commit does not fit: each seed is 20-50 `applyEdits` calls, so
 * the full corpus is ~150M edit applications and blew the ci-test-ts 600s bucket
 * watchdog (SIGKILL, exit 137) on the CI runners — which is what stopped the
 * release from cutting.
 *
 * `seedBand` keeps the FULL corpus available but runs a bounded, deterministic,
 * evenly-spaced sample on the per-commit gate, and the entire range only when
 * `HASHLINE_SEED_SOAK` is set (the scheduled soak job in ci.yml). The sample is
 * not silent: `SEEDS_ARE_SAMPLED` records the mode, and both ends of every band
 * plus the low seeds (where off-by-one walks live) are always included, so the
 * per-commit gate still exercises every band, just not all 3M seeds of it.
 */

/** True when the full seed corpus should run (scheduled soak job); false on the per-commit gate. */
export const SEED_SOAK = Boolean(process.env.HASHLINE_SEED_SOAK);

/**
 * Seeds sampled per band on the per-commit gate. 300 evenly-spaced walks per
 * band across 114 bands is ~34k walks (~2M edit applications) — a few seconds,
 * comfortably under the bucket watchdog — while still covering the full width of
 * every band. The scheduled soak runs all ~3M.
 */
export const SEEDS_PER_BAND = 300;

/** Whether the current process is sampling (per-commit) rather than running the full corpus (soak). */
export const SEEDS_ARE_SAMPLED = !SEED_SOAK;

/**
 * The seeds to exercise for a `[start, end]` band: the whole inclusive range
 * under soak or when the band is already small, otherwise a deterministic,
 * strictly-ascending, de-duplicated sample — both ends, the first few seeds, and
 * `SEEDS_PER_BAND` evenly-spaced interior seeds.
 */
export function* seedBand(start: number, end: number): Generator<number> {
	if (start > end) return;
	const total = end - start + 1;
	if (SEED_SOAK || total <= SEEDS_PER_BAND) {
		for (let seed = start; seed <= end; seed++) yield seed;
		return;
	}
	const picks = new Set<number>();
	// Low seeds and both ends: the boundaries where a walk's off-by-one first bites.
	for (const seed of [start, start + 1, start + 2, end - 1, end]) {
		if (seed >= start && seed <= end) picks.add(seed);
	}
	// Evenly spaced interior seeds so the sample tracks the whole band.
	for (let i = 0; i < SEEDS_PER_BAND; i++) {
		const seed = start + Math.floor((i * total) / SEEDS_PER_BAND);
		if (seed >= start && seed <= end) picks.add(seed);
	}
	yield* [...picks].sort((a, b) => a - b);
}
