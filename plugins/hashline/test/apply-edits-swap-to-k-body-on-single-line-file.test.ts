/**
 * Single-line file SWAP 1.=1 to k body rows for k=1..10.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits single-line file expand to k", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { text } = applyEdits("only", parsePatch(`SWAP 1.=1:\n${body}`).edits);
			expect(text).toBe(Array.from({ length: k }, (_, i) => `R${i}`).join("\n"));
		});
	}
});
