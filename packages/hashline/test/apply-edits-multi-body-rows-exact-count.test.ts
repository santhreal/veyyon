/**
 * SWAP body row count equals mid segment length for every bodyLen 1..12.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits multi body rows exact count", () => {
	const base = Array.from({ length: 5 }, (_, i) => `L${i + 1}`).join("\n");
	for (const bodyLen of [1, 2, 3, 5, 8, 12]) {
		it(`bodyLen=${bodyLen} on SWAP 2.=4`, () => {
			const rows = Array.from({ length: bodyLen }, (_, i) => `+B${i}`).join("\n");
			const { text } = applyEdits(base, parsePatch(`SWAP 2.=4:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out[0]).toBe("L1");
			expect(out.slice(1, 1 + bodyLen)).toEqual(
				Array.from({ length: bodyLen }, (_, i) => `B${i}`),
			);
			expect(out[1 + bodyLen]).toBe("L5");
			expect(out.length).toBe(2 + bodyLen);
		});
	}
});
