/**
 * SWAP middle range with body shorter/longer than range: exact exterior join.
 * Why: multi-row replace contracts/expands without shifting wrong neighbors.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 SWAP middle expand contract", () => {
	const n = 20;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	// replace lines 5..=10 (6 lines) with body of size k
	for (let k = 0; k <= 12; k++) {
		it(`SWAP 5.=10 body k=${k}`, () => {
			const rows =
				k === 0
					? ""
					: Array.from({ length: k }, (_, i) => `+M${i + 1}`).join("\n");
			const patch = k === 0 ? "SWAP 5.=10:\n" : `SWAP 5.=10:\n${rows}`;
			const { text, firstChangedLine } = applyEdits(base, parsePatch(patch).edits);
			const body = k === 0 ? [] : Array.from({ length: k }, (_, i) => `M${i + 1}`);
			const expected = [...lines.slice(0, 4), ...body, ...lines.slice(10)];
			expect(text === "" ? [] : text.split("\n")).toEqual(expected);
			expect(firstChangedLine).toBe(5);
		});
	}
});
