/**
 * Contract for seedBand, the seed selector the `apply-edits-past-6000-seeds-*`
 * fuzz-walk suites use.
 *
 * Why this suite exists: those 114 suites used to loop every seed in their band
 * (`for (let seed = A; seed <= B; seed++)`), ~3,000,000 seeds and ~150M edit
 * applications in total. On the CI runners that blew the ci-test-ts 600s bucket
 * watchdog (SIGKILL, exit 137) and stopped the release from cutting. seedBand
 * runs a bounded, deterministic sample per commit and the full range only under
 * `HASHLINE_SEED_SOAK`. These tests lock both halves of that contract so a
 * regression (sampling too little, dropping a band's ends, or letting the
 * per-commit gate explode back to the full range) fails loudly here.
 */
import { describe, expect, it } from "bun:test";
import { SEED_SOAK, SEEDS_PER_BAND, seedBand } from "./seed-band";

function collect(start: number, end: number): number[] {
	return [...seedBand(start, end)];
}

describe("seedBand", () => {
	it("yields the whole band when it is no larger than SEEDS_PER_BAND", () => {
		// Small bands keep full coverage: every seed runs.
		const seeds = collect(1000, 1000 + SEEDS_PER_BAND - 1);
		expect(seeds).toHaveLength(SEEDS_PER_BAND);
		expect(seeds[0]).toBe(1000);
		expect(seeds).toEqual(Array.from({ length: SEEDS_PER_BAND }, (_, i) => 1000 + i));
	});

	it("yields nothing for an inverted band", () => {
		expect(collect(500, 499)).toEqual([]);
	});

	// The remaining assertions describe the per-commit sampling path, which only
	// exists when the soak env is off. Under HASHLINE_SEED_SOAK every band is
	// exhaustive, so guard them so the soak job's own run of this suite still passes.
	describe.if(!SEED_SOAK)("per-commit sampling (large band)", () => {
		const START = 1_750_001;
		const END = 2_000_000; // 250_000-seed band, the largest in the corpus.

		it("samples rather than running the whole band", () => {
			const seeds = collect(START, END);
			expect(seeds.length).toBeLessThan(END - START + 1);
			// Both ends plus low seeds add at most a handful over the interior sample.
			expect(seeds.length).toBeLessThanOrEqual(SEEDS_PER_BAND + 5);
			// A meaningful sample, not a couple of points.
			expect(seeds.length).toBeGreaterThanOrEqual(SEEDS_PER_BAND);
		});

		it("always covers both ends and the low seeds where off-by-one walks bite", () => {
			const seeds = collect(START, END);
			for (const boundary of [START, START + 1, START + 2, END - 1, END]) {
				expect(seeds).toContain(boundary);
			}
		});

		it("returns strictly ascending, de-duplicated, in-range seeds", () => {
			const seeds = collect(START, END);
			for (const s of seeds) {
				expect(s).toBeGreaterThanOrEqual(START);
				expect(s).toBeLessThanOrEqual(END);
			}
			for (let i = 1; i < seeds.length; i++) {
				expect(seeds[i]).toBeGreaterThan(seeds[i - 1]);
			}
			expect(new Set(seeds).size).toBe(seeds.length);
		});

		it("is deterministic", () => {
			expect(collect(START, END)).toEqual(collect(START, END));
		});
	});

	describe.if(SEED_SOAK)("soak (full corpus)", () => {
		it("runs the entire band when HASHLINE_SEED_SOAK is set", () => {
			// A band that would otherwise sample must run every seed under soak.
			const start = 1;
			const end = SEEDS_PER_BAND * 4;
			expect(collect(start, end)).toHaveLength(end - start + 1);
		});
	});
});
