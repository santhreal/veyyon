/**
 * Disjoint SWAP then DEL multi-hunk on n=40 equals sequential (DEL first by original).
 * Why: mixed concurrent ops on disjoint lines must commute in original-index order.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP then DEL disjoint n40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let s = 1; s <= n; s++) {
		for (let d = 1; d <= n; d++) {
			if (s === d) continue;
			it(`SWAP ${s} DEL ${d}`, () => {
				const multi = applyEdits(base, parsePatch(`SWAP ${s}.=${s}:\n+S\nDEL ${d}`).edits).text;
				// sequential: apply both at original indices by applying higher index first when needed
				// multi-hunk concurrent should equal: replace s, remove d from original
				const expected = lines
					.map((l, i) => {
						const line = i + 1;
						if (line === d) return null;
						if (line === s) return "S";
						return l;
					})
					.filter((x): x is string => x !== null);
				expect(multi.split("\n")).toEqual(expected);
			});
		}
	}
});
