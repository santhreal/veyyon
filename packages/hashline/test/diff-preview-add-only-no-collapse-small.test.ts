/**
 * Added runs of length 1..5 do not collapse with default edge 2.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview small add runs no collapse", () => {
	for (const n of [1, 2, 3, 4, 5]) {
		it(`n=${n}`, () => {
			const diff = Array.from({ length: n }, (_, i) => `+${i + 1}|L${i}`).join("\n");
			const p = buildCompactDiffPreview(diff);
			expect(p.preview).not.toContain("…");
			expect(p.preview.split("\n")).toHaveLength(n);
			expect(p.addedLines).toBe(n);
		});
	}
});
