/**
 * DEL 1.=k of 8-line file for k=1..8.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL 1.=k of 8", () => {
	const n = 8;
	const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
	for (let k = 1; k <= n; k++) {
		it(`k=${k}`, () => {
			const header = k === 1 ? "DEL 1" : `DEL 1.=${k}`;
			const { text: out } = applyEdits(text, parsePatch(header).edits);
			const want = Array.from({ length: n - k }, (_, i) => `L${k + 1 + i}`).join("\n");
			expect(out).toBe(want);
		});
	}
});
