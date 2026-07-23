/**
 * Contract for sweepAnchors, the anchor selector the large-n scale suites use.
 *
 * Why this suite exists: the `apply-edits-past-6000-*` scale suites used to sweep
 * every anchor 1..n on bases up to n=100000. Each edit rebuilds the whole base
 * (O(n)), so the full sweep was O(n^2) — the n=100000 file alone was ~10^10 ops,
 * which SIGKILLed the ci-test-ts 600s bucket (exit 137) and tripped bun's 5s
 * per-test timeout on the chunked variants. sweepAnchors fixes that by staying
 * exhaustive on small bases and sampling large ones. These tests lock in both
 * halves of that contract so a regression (sampling too small a base, or letting
 * a large base explode back to a full sweep) fails loudly here.
 */
import { describe, expect, it } from "bun:test";
import { EXHAUSTIVE_MAX, INTERIOR_SAMPLES, sweepAnchors } from "./anchor-sweep";

describe("sweepAnchors", () => {
	it("returns an empty list for a non-positive base", () => {
		// Guard: no base means no anchors to exercise.
		expect(sweepAnchors(0)).toEqual([]);
		expect(sweepAnchors(-5)).toEqual([]);
	});

	it("sweeps every anchor 1..n when n <= EXHAUSTIVE_MAX", () => {
		// Small bases keep the real per-anchor behavioral coverage: the full 1..n set.
		for (const n of [1, 2, 7, 100, EXHAUSTIVE_MAX]) {
			const anchors = sweepAnchors(n);
			expect(anchors).toHaveLength(n);
			expect(anchors[0]).toBe(1);
			expect(anchors[n - 1]).toBe(n);
			expect(anchors).toEqual(Array.from({ length: n }, (_, i) => i + 1));
		}
	});

	it("samples (does not fully sweep) a base larger than EXHAUSTIVE_MAX", () => {
		// The whole point: a 100000-line base must not yield 100000 anchors.
		const n = 100000;
		const anchors = sweepAnchors(n);
		expect(anchors.length).toBeLessThan(n);
		// Bounded by the end anchors (up to 6) plus INTERIOR_SAMPLES probes.
		expect(anchors.length).toBeLessThanOrEqual(6 + INTERIOR_SAMPLES);
		// A meaningful sample, not one or two points.
		expect(anchors.length).toBeGreaterThanOrEqual(20);
	});

	it("always covers both ends and their off-by-one boundaries on a large base", () => {
		// Off-by-one bugs live at the edges, so the sample must pin them.
		const n = 50000;
		const anchors = sweepAnchors(n);
		for (const boundary of [1, 2, 3, n - 2, n - 1, n]) {
			expect(anchors).toContain(boundary);
		}
	});

	it("returns strictly ascending, de-duplicated, in-range anchors on a large base", () => {
		// Callers iterate the list directly against an n-line base; every anchor
		// must be a valid 1..n index and appear once.
		const n = 80000;
		const anchors = sweepAnchors(n);
		for (const a of anchors) {
			expect(a).toBeGreaterThanOrEqual(1);
			expect(a).toBeLessThanOrEqual(n);
		}
		for (let i = 1; i < anchors.length; i++) {
			expect(anchors[i]).toBeGreaterThan(anchors[i - 1]);
		}
		expect(new Set(anchors).size).toBe(anchors.length);
	});

	it("is deterministic", () => {
		// The scale suites must be reproducible run-to-run; no randomness.
		expect(sweepAnchors(60000)).toEqual(sweepAnchors(60000));
	});
});
