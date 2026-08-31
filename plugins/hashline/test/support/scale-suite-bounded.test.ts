/**
 * Meta-guard: no large-base scale suite may sweep every anchor.
 *
 * Why this suite exists: the `apply-edits-past-6000-*` suites bricked the CI
 * test_workspace bucket for four releases (1.0.13-1.0.16). Each swept every
 * anchor 1..n on bases up to n=100000, and because each applyEdits rebuilds the
 * base (O(n)), the full sweep was O(n^2) — it blew bun's 5s per-test timeout,
 * the ci-test-ts 600s bucket watchdog (SIGKILL 137), and OOM-crashed workers.
 * The fix was sweepAnchors (test/support/anchor-sweep.ts). This guard fails the
 * moment a new (or regenerated) suite reintroduces a large exhaustive sweep, so
 * the release can never silently break the same way again.
 *
 * The rule targets the exact shape that broke: an anchor/count sweep that starts
 * at 1 and runs to a bound of >= SCALE_FLOOR — `for (let <id> = 1; <id> <= <N>; …)`
 * where N is a literal >= SCALE_FLOOR or an `<id>` whose `const` value is — while
 * calling applyEdits/parsePatch. Such a file MUST import sweepAnchors. This does
 * NOT flag seed-driven property suites (their loop starts at a large seed value,
 * not 1, over a small growing base) or small exhaustive suites (bound < floor).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Anchor sweeps to a bound at or above this size must go through sweepAnchors.
// Matches EXHAUSTIVE_MAX (4000) with headroom: the smallest bounded suites are 6000.
const SCALE_FLOOR = 6000;
const TEST_DIR = join(import.meta.dir, "..");

function listTestFiles(): string[] {
	return readdirSync(TEST_DIR)
		.filter(name => name.endsWith(".test.ts"))
		.sort();
}

/** Map of `const <id> = <number>` in the file, for resolving symbolic loop bounds. */
function numericConsts(src: string): Map<string, number> {
	const consts = new Map<string, number>();
	for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*(\d+)\b/g)) {
		consts.set(m[1], Number(m[2]));
	}
	return consts;
}

/**
 * True when the file contains a `for (let <id> = 1; <id> <= <bound>; …)` loop
 * whose bound is >= SCALE_FLOOR (a numeric literal, or an `<id>` const that is).
 * That is the from-1 sweep shape; seed loops (from a large start) never match.
 */
function hasLargeFromOneSweep(src: string): boolean {
	const consts = numericConsts(src);
	for (const m of src.matchAll(/\bfor\s*\(\s*let\s+\w+\s*=\s*1\s*;\s*\w+\s*<=\s*([A-Za-z_]\w*|\d+)\s*;/g)) {
		const bound = m[1];
		const value = /^\d+$/.test(bound) ? Number(bound) : (consts.get(bound) ?? 0);
		if (value >= SCALE_FLOOR) return true;
	}
	return false;
}

function callsApplyEdits(src: string): boolean {
	return /\b(applyEdits|parsePatch|formatReplaceHeader|formatDeleteHeader)\b/.test(src);
}

/**
 * True when the file contains a raw counting loop over a seed band — the shape
 * the `-seeds-` fuzz suites used before seedBand: `for (let <id> = <A>; <id> <=
 * <B>; <id>++)` where the band `B - A + 1` is larger than a single sample would
 * be (>= SEED_BAND_FLOOR). Those must go through seedBand so the per-commit gate
 * samples them; only the scheduled soak runs the whole band.
 */
const SEED_BAND_FLOOR = 1000;
function hasRawLargeSeedLoop(src: string): boolean {
	for (const m of src.matchAll(/\bfor\s*\(\s*let\s+\w+\s*=\s*(\d+)\s*;\s*\w+\s*<=\s*(\d+)\s*;/g)) {
		const start = Number(m[1]);
		const end = Number(m[2]);
		if (start >= 1 && end - start + 1 >= SEED_BAND_FLOOR) return true;
	}
	return false;
}

describe("large-base scale suites stay bounded", () => {
	it("every from-1 sweep to a >=6000 bound goes through sweepAnchors", () => {
		const offenders: string[] = [];
		for (const name of listTestFiles()) {
			const src = readFileSync(join(TEST_DIR, name), "utf8");
			if (!hasLargeFromOneSweep(src)) continue;
			if (!callsApplyEdits(src)) continue;
			if (src.includes("sweepAnchors")) continue;
			offenders.push(name);
		}
		// Assert the exact set (empty) so a regression names the offending file.
		expect(offenders).toEqual([]);
	});

	it("finds the bounded suites it is meant to protect (guard is not vacuous)", () => {
		// Sanity: the guard must actually see the large bounded suites, or a broken
		// scan (wrong dir/regex) would pass while protecting nothing.
		const bounded = listTestFiles().filter(name => {
			const src = readFileSync(join(TEST_DIR, name), "utf8");
			return src.includes("sweepAnchors") && src.includes("apply");
		});
		expect(bounded.length).toBeGreaterThanOrEqual(40);
	});

	it("does not flag seed-driven property suites (loop starts at a large seed, not 1)", () => {
		// Regression: an earlier version matched seed range boundaries (e.g. 3002000)
		// as a base size and flagged every apply-edits-past-6000-seeds-* file.
		const seedFiles = listTestFiles().filter(name => name.includes("-seeds-"));
		expect(seedFiles.length).toBeGreaterThan(0);
		for (const name of seedFiles) {
			const src = readFileSync(join(TEST_DIR, name), "utf8");
			expect(hasLargeFromOneSweep(src)).toBe(false);
		}
	});

	it("no seed suite runs a raw large band (>=1000 seeds) — those must use seedBand", () => {
		// The blocker that stopped the release: the large -seeds- suites looped every
		// seed in their band (~3M total), SIGKILLing the 600s bucket. seedBand samples
		// on the per-commit gate and runs the full band only under HASHLINE_SEED_SOAK.
		// Small seed suites (a few dozen seeds) may still loop raw — the cost is
		// trivial — so the guard targets only large raw bands, the shape that broke.
		const offenders: string[] = [];
		for (const name of listTestFiles().filter(n => n.includes("-seeds-"))) {
			const src = readFileSync(join(TEST_DIR, name), "utf8");
			if (hasRawLargeSeedLoop(src)) offenders.push(name);
		}
		expect(offenders).toEqual([]);
	});

	it("finds the large seed suites it protects (guard is not vacuous)", () => {
		// The large-band seed suites must actually be present and routed through
		// seedBand, or the guard above would pass while protecting nothing.
		const routed = listTestFiles().filter(name => {
			const src = readFileSync(join(TEST_DIR, name), "utf8");
			return name.includes("-seeds-") && src.includes("seedBand(");
		});
		expect(routed.length).toBeGreaterThanOrEqual(100);
	});
});
