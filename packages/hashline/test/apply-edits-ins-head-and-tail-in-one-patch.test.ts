/**
 * Single patch with both INS.HEAD and INS.TAIL: sandwich exact.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.HEAD and INS.TAIL in one patch", () => {
	for (const base of ["", "mid", "a\nb\nc"]) {
		for (const hk of [1, 2, 3]) {
			for (const tk of [1, 2]) {
				it(`base=${JSON.stringify(base)} head=${hk} tail=${tk}`, () => {
					const head = Array.from({ length: hk }, (_, i) => `+H${i}`).join("\n");
					const tail = Array.from({ length: tk }, (_, i) => `+T${i}`).join("\n");
					const { text } = applyEdits(
						base,
						parsePatch(`INS.HEAD:\n${head}\nINS.TAIL:\n${tail}`).edits,
					);
					const out = text.split("\n");
					expect(out.slice(0, hk)).toEqual(
						Array.from({ length: hk }, (_, i) => `H${i}`),
					);
					expect(out.slice(out.length - tk)).toEqual(
						Array.from({ length: tk }, (_, i) => `T${i}`),
					);
					if (base) {
						expect(out.slice(hk, out.length - tk).join("\n")).toBe(base);
					}
				});
			}
		}
	}
});
