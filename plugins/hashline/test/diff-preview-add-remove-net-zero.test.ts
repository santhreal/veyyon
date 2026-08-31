/**
 * Equal add and remove counts renumber context with zero net offset.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview net-zero offset", () => {
	for (const n of [1, 2, 3]) {
		it(`replace ${n} lines with ${n} lines`, () => {
			const lines: string[] = [" 1|head"];
			for (let i = 0; i < n; i++) lines.push(`-${2 + i}|old${i}`);
			for (let i = 0; i < n; i++) lines.push(`+${2 + i}|new${i}`);
			lines.push(` ${2 + n}|tail`);
			const p = buildCompactDiffPreview(lines.join("\n"));
			expect(p.addedLines).toBe(n);
			expect(p.removedLines).toBe(n);
			const rows = p.preview.split("\n");
			expect(rows[0]).toBe("1:head");
			expect(rows[rows.length - 1]).toBe(`${2 + n}:tail`);
		});
	}
});
