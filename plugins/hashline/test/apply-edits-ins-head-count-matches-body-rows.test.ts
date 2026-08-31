/**
 * INS.HEAD body row count equals prefix length for k in 1..30.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.HEAD count matches body rows", () => {
	for (const k of [1, 2, 3, 7, 15, 30]) {
		it(`k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i}`).join("\n");
			const { text } = applyEdits("BODY", parsePatch(`INS.HEAD:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out).toHaveLength(k + 1);
			expect(out[out.length - 1]).toBe("BODY");
			expect(out.slice(0, k)).toEqual(Array.from({ length: k }, (_, i) => `H${i}`));
		});
	}
});
