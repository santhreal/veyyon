/**
 * INS.PRE then DEL the inserted line at the same index: restores original.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits INS.PRE then DEL inserted", () => {
	const base = "a\nb\nc\nd\ne";
	for (let anchor = 1; anchor <= 5; anchor++) {
		it(`PRE ${anchor} then DEL insert`, () => {
			let t = apply(base, `INS.PRE ${anchor}:\n+INSERTED`);
			expect(t.split("\n")[anchor - 1]).toBe("INSERTED");
			t = apply(t, `DEL ${anchor}`);
			expect(t).toBe(base);
		});
	}
});
