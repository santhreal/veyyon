/**
 * INS.POST line grid: for each anchor 1..n, inserted row sits immediately after
 * and total length is n+1.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST grid property", () => {
	for (const n of [3, 6, 10]) {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		for (let anchor = 1; anchor <= n; anchor++) {
			it(`n=${n} INS.POST ${anchor}`, () => {
				const { text } = applyEdits(base, parsePatch(`INS.POST ${anchor}:\n+X`).edits);
				const out = text.split("\n");
				expect(out).toHaveLength(n + 1);
				expect(out[anchor]).toBe("X");
				expect(out.slice(0, anchor)).toEqual(lines.slice(0, anchor));
				expect(out.slice(anchor + 1)).toEqual(lines.slice(anchor));
			});
		}
	}
});
