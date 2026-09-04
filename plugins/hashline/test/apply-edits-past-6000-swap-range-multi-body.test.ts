/**
 * SWAP range with multi-line body: range replaced by body row count (not 1:1).
 * Why: multi-row SWAP payload must expand/contract the file exactly.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP range multi body", () => {
	const base = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");

	for (let bodyRows = 1; bodyRows <= 8; bodyRows++) {
		it(`SWAP 3.=5 with ${bodyRows} body rows`, () => {
			const rows = Array.from({ length: bodyRows }, (_, i) => `+B${i + 1}`).join("\n");
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`SWAP 3.=5:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out.slice(0, 2)).toEqual(["L1", "L2"]);
			expect(out.slice(2, 2 + bodyRows)).toEqual(Array.from({ length: bodyRows }, (_, i) => `B${i + 1}`));
			expect(out.slice(2 + bodyRows)).toEqual(Array.from({ length: 5 }, (_, i) => `L${i + 6}`));
			expect(out).toHaveLength(2 + bodyRows + 5);
			expect(firstChangedLine).toBe(3);
		});
	}

	it("SWAP 1.=10 with single row clears to one line", () => {
		const { text } = applyEdits(base, parsePatch("SWAP 1.=10:\n+ONLY").edits);
		expect(text).toBe("ONLY");
	});

	it("SWAP 1.=10 with empty body is rejected; DEL 1.=10 clears the file", () => {
		// A bodyless SWAP is not "clear the range" — it throws EMPTY_REPLACE
		// (silent-delete footgun removed). Clearing the whole file is DEL 1.=10.
		expect(() => parsePatch("SWAP 1.=10:\n")).toThrow(EMPTY_REPLACE);
		expect(applyEdits(base, parsePatch("DEL 1.=10").edits).text).toBe("");
	});
});
