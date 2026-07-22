/**
 * Multiple disjoint SWAP hunks in one patch: later ranges address pre-edit
 * line numbers (all anchors against original file). Exact body placement.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits multi disjoint SWAP order property", () => {
	for (const n of [6, 8, 12]) {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");

		it(`n=${n} swap first and last single lines`, () => {
			const { text } = applyEdits(
				base,
				parsePatch(`SWAP 1.=1:\n+A\nSWAP ${n}.=${n}:\n+Z`).edits,
			);
			const out = text.split("\n");
			expect(out[0]).toBe("A");
			expect(out[n - 1]).toBe("Z");
			expect(out.slice(1, n - 1)).toEqual(lines.slice(1, n - 1));
		});

		it(`n=${n} swap mid pair 2 and 4`, () => {
			if (n < 5) return;
			const { text } = applyEdits(
				base,
				parsePatch("SWAP 2.=2:\n+X\nSWAP 4.=4:\n+Y").edits,
			);
			const out = text.split("\n");
			expect(out[1]).toBe("X");
			expect(out[3]).toBe("Y");
			expect(out[0]).toBe("L1");
			expect(out[2]).toBe("L3");
		});

		it(`n=${n} expand line 2 and shrink last two into one`, () => {
			const patch = `SWAP 2.=2:\n+P\n+Q\nSWAP ${n - 1}.=${n}:\n+TAIL`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			const out = text.split("\n");
			expect(out[0]).toBe("L1");
			expect(out[1]).toBe("P");
			expect(out[2]).toBe("Q");
			// lines 3..n-2 stay (indices 2..n-3 in original after expand offset)
			// original line 3 is now at index 3
			expect(out[3]).toBe("L3");
			expect(out[out.length - 1]).toBe("TAIL");
			// net: +1 from expand, -1 from shrink two->one => same length
			expect(out.length).toBe(n);
		});
	}
});
