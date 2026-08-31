/**
 * After INS.HEAD k rows, original line i is at i+k; SWAP by new index.
 * Why: sequential apply renumbers; concurrent multi-hunk would use original.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS HEAD then SWAP original", () => {
	const base = "A\nB\nC\nD\nE";

	for (let k = 1; k <= 20; k++) {
		it(`HEAD k=${k} then SWAP new index of B`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i + 1}`).join("\n");
			const stacked = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
			const bIndex = k + 2; // H1..Hk, A, B → B at k+2
			const swapped = applyEdits(stacked, parsePatch(`SWAP ${bIndex}.=${bIndex}:\n+BB`).edits).text;
			const out = swapped.split("\n");
			expect(out[k]).toBe("A");
			expect(out[k + 1]).toBe("BB");
			expect(out[k + 2]).toBe("C");
		});
	}
});
