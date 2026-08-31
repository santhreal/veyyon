/**
 * Stack k TAIL inserts then DEL suffix restores base for k=1..40.
 * Why: TAIL stack is reversible by deleting the new suffix by line number.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 stack TAIL unstack DEL", () => {
	const base = "A\nB\nC\nD\nE";
	const baseLen = 5;

	for (let k = 1; k <= 40; k++) {
		it(`stack ${k} TAIL then DEL suffix`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+T${i + 1}`).join("\n");
			const stacked = applyEdits(base, parsePatch(`INS.TAIL:\n${rows}`).edits).text;
			expect(stacked.split("\n")).toHaveLength(baseLen + k);
			const start = baseLen + 1;
			const end = baseLen + k;
			const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
			const restored = applyEdits(stacked, parsePatch(header).edits).text;
			expect(restored).toBe(base);
		});
	}
});
