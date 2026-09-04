/**
 * Stack k HEAD inserts then DEL 1..=k restores base for k=1..40.
 * Why: HEAD stack is reversible only by deleting the exact new prefix.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 stack HEAD unstack DEL", () => {
	const base = "A\nB\nC\nD\nE";

	for (let k = 1; k <= 40; k++) {
		it(`stack ${k} HEAD then DEL 1..=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i + 1}`).join("\n");
			const stacked = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			expect(stacked.split("\n")).toHaveLength(5 + k);
			const header = k === 1 ? "DEL 1" : `DEL 1.=${k}`;
			const restored = applyEdits(stacked, parsePatch(header).edits).text;
			expect(restored).toBe(base);
		});
	}
});
