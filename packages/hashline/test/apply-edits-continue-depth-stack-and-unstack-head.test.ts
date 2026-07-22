/**
 * Stack k HEAD inserts then unstack with DEL 1 repeated k times.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits continue depth stack and unstack HEAD", () => {
	for (const k of [3, 7, 12]) {
		it(`k=${k}`, () => {
			const base = "CORE";
			let t = base;
			for (let i = 0; i < k; i++) t = apply(t, `INS.HEAD:\n+H${i}`);
			expect(t.split("\n")).toHaveLength(k + 1);
			for (let i = 0; i < k; i++) t = apply(t, "DEL 1");
			expect(t).toBe(base);
		});
	}
});
