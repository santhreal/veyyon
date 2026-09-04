/**
 * Compact diff preview: systematic net-offset cases for context renumbering.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview offset matrix", () => {
	for (const removed of [0, 1, 2, 3]) {
		for (const added of [0, 1, 2, 3]) {
			if (removed === 0 && added === 0) continue;
			it(`remove ${removed} add ${added} renumbers trailing context by ${added - removed}`, () => {
				const lines: string[] = [" 1|head"];
				for (let i = 0; i < removed; i++) lines.push(`-${2 + i}|rm${i}`);
				for (let i = 0; i < added; i++) lines.push(`+${2 + i}|ad${i}`);
				// pre-edit context at line 2+removed
				const preCtx = 2 + removed;
				lines.push(` ${preCtx}|tail`);
				const p = buildCompactDiffPreview(lines.join("\n"));
				expect(p.removedLines).toBe(removed);
				expect(p.addedLines).toBe(added);
				const rows = p.preview.split("\n");
				expect(rows[0]).toBe("1:head");
				const last = rows[rows.length - 1];
				const expectedTailNum = preCtx + added - removed;
				expect(last).toBe(`${expectedTailNum}:tail`);
			});
		}
	}
});
