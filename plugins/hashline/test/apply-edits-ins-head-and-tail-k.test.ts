/**
 * INS.HEAD k and INS.TAIL m in one parse sandwich the body.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits HEAD+TAIL sandwich sizes", () => {
	for (const hk of [1, 2, 3]) {
		for (const tk of [1, 2, 3]) {
			it(`head=${hk} tail=${tk}`, () => {
				const head = Array.from({ length: hk }, (_, i) => `+H${i}`).join("\n");
				const tail = Array.from({ length: tk }, (_, i) => `+T${i}`).join("\n");
				const { text } = applyEdits("MID", parsePatch(`INS.HEAD:\n${head}\nINS.TAIL:\n${tail}`).edits);
				const h = Array.from({ length: hk }, (_, i) => `H${i}`);
				const t = Array.from({ length: tk }, (_, i) => `T${i}`);
				expect(text).toBe([...h, "MID", ...t].join("\n"));
			});
		}
	}
});
