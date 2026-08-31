/**
 * SWAP middle range with body shorter/longer than range: exact exterior join.
 * Why: multi-row replace contracts/expands without shifting wrong neighbors.
 * k=0 (a bodyless SWAP) is not a contract-to-empty: it is rejected with
 * EMPTY_REPLACE (silent-delete footgun removed; the delete is DEL 5.=10).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP middle expand contract", () => {
	const n = 20;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("SWAP 5.=10 with an empty body is rejected", () => {
		expect(() => parsePatch("SWAP 5.=10:\n")).toThrow(EMPTY_REPLACE);
	});

	// replace lines 5..=10 (6 lines) with body of size k>=1
	for (let k = 1; k <= 12; k++) {
		it(`SWAP 5.=10 body k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+M${i + 1}`).join("\n");
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`SWAP 5.=10:\n${rows}`).edits);
			const body = Array.from({ length: k }, (_, i) => `M${i + 1}`);
			const expected = [...lines.slice(0, 4), ...body, ...lines.slice(10)];
			expect(text === "" ? [] : text.split("\n")).toEqual(expected);
			expect(firstChangedLine).toBe(5);
		});
	}
});
