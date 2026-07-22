/**
 * buildCompactDiffPreview only-adds runs for lengths 1..12 with default collapse.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview only-adds length matrix", () => {
	for (let n = 1; n <= 12; n++) {
		it(`n=${n} addedLines=${n}`, () => {
			const diff = Array.from({ length: n }, (_, i) => `+${i + 1}|L${i}`).join("\n");
			const p = buildCompactDiffPreview(diff);
			expect(p.addedLines).toBe(n);
			expect(p.removedLines).toBe(0);
			const rows = p.preview.split("\n").filter(Boolean);
			if (n <= 5) {
				// default edge 2 → threshold 5: no collapse
				expect(rows).not.toContain("…");
				expect(rows).toHaveLength(n);
			} else {
				expect(rows).toContain("…");
				// head 2 + marker + tail 2
				expect(rows[0]).toBe(`1:L0`);
				expect(rows[rows.length - 1]).toBe(`${n}:L${n - 1}`);
			}
		});
	}
});
