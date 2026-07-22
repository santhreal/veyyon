/**
 * Property: after SWAP start..=end with bodyLen rows, new length = old - (end-start+1) + bodyLen.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits property SWAP length delta", () => {
	const n = 20;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let start = 1; start <= 8; start++) {
		for (let end = start; end <= start + 4 && end <= n; end++) {
			for (const bodyLen of [1, 2, 5, 10]) {
				it(`s=${start} e=${end} b=${bodyLen}`, () => {
					const span = end - start + 1;
					const rows = Array.from({ length: bodyLen }, (_, i) => `+B${i}`).join("\n");
					const { text } = applyEdits(
						base,
						parsePatch(`SWAP ${start}.=${end}:\n${rows}`).edits,
					);
					expect(text.split("\n").length).toBe(n - span + bodyLen);
				});
			}
		}
	}
});
