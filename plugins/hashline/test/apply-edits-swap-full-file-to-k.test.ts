/**
 * SWAP entire file range to k body lines for k=1..6.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP full file to k lines", () => {
	const n = 4;
	const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
	for (let k = 1; k <= 6; k++) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+N${i}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP 1.=${n}:\n${body}`).edits);
			const want = Array.from({ length: k }, (_, i) => `N${i}`).join("\n");
			expect(out).toBe(want);
		});
	}
});
