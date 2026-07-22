/**
 * Sequential INS.HEAD k then INS.TAIL m.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits sequential HEAD then TAIL counts", () => {
	for (const hk of [1, 2, 3]) {
		for (const tk of [1, 2, 3]) {
			it(`h=${hk} t=${tk}`, () => {
				const head = Array.from({ length: hk }, (_, i) => `+H${i}`).join("\n");
				let text = applyEdits("MID", parsePatch(`INS.HEAD:\n${head}`).edits).text;
				const tail = Array.from({ length: tk }, (_, i) => `+T${i}`).join("\n");
				text = applyEdits(text, parsePatch(`INS.TAIL:\n${tail}`).edits).text;
				const h = Array.from({ length: hk }, (_, i) => `H${i}`);
				const t = Array.from({ length: tk }, (_, i) => `T${i}`);
				expect(text).toBe([...h, "MID", ...t].join("\n"));
			});
		}
	}
});
