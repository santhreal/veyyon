/**
 * SWAP line 1 of single-line file to bodyLen 1..20: exact length and content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP body row count 1 to 20", () => {
	for (let bodyLen = 1; bodyLen <= 20; bodyLen++) {
		it(`bodyLen=${bodyLen}`, () => {
			const body = Array.from({ length: bodyLen }, (_, i) => `R${i}`);
			const rows = body.map(l => `+${l}`).join("\n");
			const { text } = applyEdits("ONLY", parsePatch(`SWAP 1.=1:\n${rows}`).edits);
			expect(text.split("\n")).toEqual(body);
		});
	}
});
