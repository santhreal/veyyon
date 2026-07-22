/**
 * DEL k.=n for k=1..n on an n-line file leaves the prefix.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL suffix ranges", () => {
	const n = 6;
	const text = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
	for (let k = 1; k <= n; k++) {
		it(`DEL ${k}.=${n}`, () => {
			const header = k === n ? `DEL ${n}` : `DEL ${k}.=${n}`;
			const { text: out } = applyEdits(text, parsePatch(header).edits);
			const want = Array.from({ length: k - 1 }, (_, i) => `L${i + 1}`).join("\n");
			expect(out).toBe(want);
		});
	}
});
