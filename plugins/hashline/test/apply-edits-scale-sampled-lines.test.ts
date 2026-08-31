/**
 * Scale contract for single-line DEL and single-line replace (SWAP) on large
 * files, 50k through 5M lines, at deterministically SAMPLED positions.
 *
 * This suite replaces 31 generated files
 * (apply-edits-past-6000-{del,swap}-line-1-to-<n>.test.ts, n in
 * 50000..5000000) that each executed one applyEdits call PER LINE of an
 * n-line base — ~24 million applies totalling far beyond any feasible
 * runtime. Those suites could never complete: `bun test` in this package was
 * SIGKILLed mid-run every time it reached them (2026-07-22), which silently
 * cost the coverage of every other suite in the package. Exhaustive 1..n
 * enumeration proves nothing beyond what edges + a deterministic sample
 * prove about a position-uniform operation, and the per-position assertions
 * here are byte-real, so the actual contract — single-line edits resolve to
 * the right line with the right firstChangedLine on multi-million-line
 * files, including every boundary — is fully preserved at a runtime the
 * suite can actually deliver.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

setDefaultTimeout(120_000);

const SIZES = [
	50_000, 60_000, 80_000, 100_000, 120_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000, 1_000_000,
	2_000_000, 3_000_000, 5_000_000,
] as const;

/**
 * Boundary positions (first three, around the midpoint, last three) plus a
 * fixed 13-point spread. Deterministic: same positions every run, so a
 * failure is reproducible by name.
 */
function sampledPositions(n: number): number[] {
	const positions = new Set<number>([
		1,
		2,
		3,
		Math.floor(n / 2) - 1,
		Math.floor(n / 2),
		Math.floor(n / 2) + 1,
		n - 2,
		n - 1,
		n,
	]);
	const stride = Math.floor(n / 13);
	for (let k = 1; k <= 12; k++) positions.add(k * stride);
	return [...positions].filter(p => p >= 1 && p <= n).sort((a, b) => a - b);
}

for (const n of SIZES) {
	describe(`applyEdits scale n=${n} (sampled positions)`, () => {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");

		it("DEL at every sampled position removes exactly that line", () => {
			for (const i of sampledPositions(n)) {
				const { text, firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
				expect(firstChangedLine).toBe(i);
				const out = text.split("\n");
				expect(out.length).toBe(n - 1);
				// The neighbors close over the gap: position i now holds old line i+1
				// (or the file ends there when i was the last line).
				if (i < n) expect(out[i - 1]).toBe(`L${i + 1}`);
				if (i > 1) expect(out[i - 2]).toBe(`L${i - 1}`);
			}
		});

		it("single-line replace at every sampled position rewrites exactly that line", () => {
			for (const i of sampledPositions(n)) {
				const { text, firstChangedLine } = applyEdits(base, parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits);
				expect(firstChangedLine).toBe(i);
				const out = text.split("\n");
				expect(out.length).toBe(n);
				expect(out[i - 1]).toBe(`X${i}`);
				if (i > 1) expect(out[i - 2]).toBe(`L${i - 1}`);
				if (i < n) expect(out[i]).toBe(`L${i + 1}`);
			}
		});
	});
}
