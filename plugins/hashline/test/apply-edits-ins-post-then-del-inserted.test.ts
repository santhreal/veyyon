/**
 * INS.POST then DEL the inserted line by its new index: restores original.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits INS.POST then DEL inserted", () => {
	const base = "a\nb\nc\nd\ne";
	for (let anchor = 1; anchor <= 5; anchor++) {
		it(`POST ${anchor} then DEL insert`, () => {
			let t = apply(base, `INS.POST ${anchor}:\n+INSERTED`);
			expect(t.split("\n")[anchor]).toBe("INSERTED");
			t = apply(t, `DEL ${anchor + 1}`);
			expect(t).toBe(base);
		});
	}
});
