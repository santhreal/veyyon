/**
 * Stack k HEAD inserts then DEL 1..=k restores base for k=1..80.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 stack HEAD unstack DEL k 1 to 80", () => {
	const base = "A\nB";

	for (let k = 1; k <= 80; k++) {
		it(`stack ${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i + 1}`).join("\n");
			const stacked = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			const header = k === 1 ? "DEL 1" : `DEL 1.=${k}`;
			expect(applyEdits(stacked, parsePatch(header).edits).text).toBe(base);
		});
	}
});
