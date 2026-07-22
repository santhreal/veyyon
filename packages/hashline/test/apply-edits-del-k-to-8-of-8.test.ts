/**
 * DEL k.=8 of 8-line file for k=1..8.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL k.=8 of 8", () => {
	const n = 8;
	const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
	for (let k = 1; k <= n; k++) {
		it(`k=${k}`, () => {
			const header = k === n ? `DEL ${n}` : `DEL ${k}.=${n}`;
			const { text: out } = applyEdits(text, parsePatch(header).edits);
			const want = Array.from({ length: k - 1 }, (_, i) => `L${i + 1}`).join("\n");
			expect(out).toBe(want);
		});
	}
});
