/**
 * INS.TAIL body row count equals suffix length for k in 1..30.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.TAIL count matches body rows", () => {
	for (const k of [1, 2, 3, 7, 15, 30]) {
		it(`k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+T${i}`).join("\n");
			const { text } = applyEdits("BODY", parsePatch(`INS.TAIL:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out).toHaveLength(k + 1);
			expect(out[0]).toBe("BODY");
			expect(out.slice(1)).toEqual(Array.from({ length: k }, (_, i) => `T${i}`));
		});
	}
});
