/**
 * SWAP every single line to TOKEN on a 5-line file: exact neighbors preserved.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP every line index", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	for (let i = 1; i <= base.length; i++) {
		it(`SWAP ${i}.=${i} to T${i}`, () => {
			const h = formatReplaceHeader(i, i);
			const { text: out } = applyEdits(text, parsePatch(`${h}\n+T${i}`).edits);
			const want = base.map((ch, idx) => (idx + 1 === i ? `T${i}` : ch));
			expect(out).toBe(want.join("\n"));
		});
	}

	it("SWAP full range 1.=5 to single line", () => {
		const h = formatReplaceHeader(1, 5);
		const { text: out } = applyEdits(text, parsePatch(`${h}\n+ONLY`).edits);
		expect(out).toBe("ONLY");
	});

	it("SWAP 2.=4 shrinks middle", () => {
		const h = formatReplaceHeader(2, 4);
		const { text: out } = applyEdits(text, parsePatch(`${h}\n+M`).edits);
		expect(out).toBe("a\nM\ne");
	});
});
