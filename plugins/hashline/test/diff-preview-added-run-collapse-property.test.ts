/**
 * buildCompactDiffPreview collapses long added runs with … marker when
 * above edge*2+1 threshold; short runs stay expanded.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "@veyyon/hashline";

function addedRun(n: number, startLine = 1): string {
	return Array.from({ length: n }, (_, i) => `+${startLine + i}|L${i}`).join("\n");
}

describe("buildCompactDiffPreview added-run collapse property", () => {
	for (const edge of [1, 2, 3]) {
		const threshold = edge * 2 + 1;
		it(`edge=${edge}: at threshold ${threshold} no collapse`, () => {
			const r = buildCompactDiffPreview(addedRun(threshold), {
				maxAddedRunContext: edge,
			});
			expect(r.preview.includes("…")).toBe(false);
			expect(r.addedLines).toBe(threshold);
		});

		it(`edge=${edge}: above threshold collapses`, () => {
			const n = threshold + 3;
			const r = buildCompactDiffPreview(addedRun(n), { maxAddedRunContext: edge });
			expect(r.preview).toContain("…");
			expect(r.addedLines).toBe(n);
			// edge lines at start and end still present
			expect(r.preview).toContain("L0");
			expect(r.preview).toContain(`L${n - 1}`);
		});
	}

	it("remove-only counts removedLines", () => {
		const diff = "-1|a\n-2|b\n 3|c";
		const r = buildCompactDiffPreview(diff);
		expect(r.removedLines).toBe(2);
		expect(r.addedLines).toBe(0);
		// removed lines omitted from preview
		expect(r.preview).not.toContain("|a");
	});
});
