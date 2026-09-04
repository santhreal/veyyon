/**
 * SWAP last line of 3-line file to bodyLen k for k=1..25: length = 2+k.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth SWAP last line body k 1 to 25", () => {
	const base = "a\nb\nc";
	for (let k = 1; k <= 25; k++) {
		it(`k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits(base, parsePatch(`SWAP 3.=3:\n${rows}`).edits);
			expect(text.split("\n").length).toBe(2 + k);
			expect(text.split("\n").slice(0, 2)).toEqual(["a", "b"]);
		});
	}
});
