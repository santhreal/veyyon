/**
 * Context-only diffs renumber 1:1 with zero counts.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview context-only", () => {
	for (const n of [1, 2, 5, 10]) {
		it(`n=${n} context lines`, () => {
			const diff = Array.from({ length: n }, (_, i) => ` ${i + 1}|L${i}`).join("\n");
			const p = buildCompactDiffPreview(diff);
			expect(p.addedLines).toBe(0);
			expect(p.removedLines).toBe(0);
			expect(p.preview).toBe(
				Array.from({ length: n }, (_, i) => `${i + 1}:L${i}`).join("\n"),
			);
		});
	}
});
