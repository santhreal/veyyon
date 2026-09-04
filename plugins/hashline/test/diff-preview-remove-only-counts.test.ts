/**
 * Removal-only diffs: exact removedLines and empty preview.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview remove-only", () => {
	for (const n of [1, 2, 3, 5, 8]) {
		it(`n=${n} removals`, () => {
			const diff = Array.from({ length: n }, (_, i) => `-${i + 1}|rm${i}`).join("\n");
			const p = buildCompactDiffPreview(diff);
			expect(p.removedLines).toBe(n);
			expect(p.addedLines).toBe(0);
			expect(p.preview).toBe("");
		});
	}
});
