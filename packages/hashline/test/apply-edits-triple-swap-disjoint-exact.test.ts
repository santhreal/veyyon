/**
 * Three disjoint single-line SWAPs in one patch: exact body placement.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits triple SWAP disjoint exact", () => {
	for (const n of [6, 9, 12]) {
		it(`n=${n} SWAP 1, mid, last`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const mid = Math.ceil(n / 2);
			const patch = `SWAP 1.=1:\n+A\nSWAP ${mid}.=${mid}:\n+M\nSWAP ${n}.=${n}:\n+Z`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			const out = text.split("\n");
			expect(out[0]).toBe("A");
			expect(out[mid - 1]).toBe("M");
			expect(out[n - 1]).toBe("Z");
			for (let i = 1; i < n - 1; i++) {
				if (i + 1 === mid) continue;
				expect(out[i]).toBe(lines[i]);
			}
		});
	}
});
