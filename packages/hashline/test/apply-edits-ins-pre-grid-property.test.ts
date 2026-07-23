/**
 * INS.PRE line grid: inserted row sits at the anchor index; original shifts down.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE grid property", () => {
	for (const n of [3, 6, 10]) {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		for (let anchor = 1; anchor <= n; anchor++) {
			it(`n=${n} INS.PRE ${anchor}`, () => {
				const { text } = applyEdits(base, parsePatch(`INS.PRE ${anchor}:\n+X`).edits);
				const out = text.split("\n");
				expect(out).toHaveLength(n + 1);
				expect(out[anchor - 1]).toBe("X");
				expect(out[anchor]).toBe(lines[anchor - 1]);
				expect(out.slice(0, anchor - 1)).toEqual(lines.slice(0, anchor - 1));
				expect(out.slice(anchor + 1)).toEqual(lines.slice(anchor));
			});
		}
	}
});
