/**
 * applyEdits with empty edits array is identity with undefined firstChangedLine.
 * Why: empty patch path must not invent a change line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 empty ops list", () => {
	const bases = ["", "a", "a\nb", "a\nb\nc", Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n")];

	for (const [i, base] of bases.entries()) {
		it(`empty edits identity base#${i}`, () => {
			const r = applyEdits(base, []);
			expect(r.text).toBe(base);
			expect(r.firstChangedLine).toBeUndefined();
		});
	}

	it("parse empty string yields empty edits", () => {
		const { edits } = parsePatch("");
		expect(edits).toEqual([]);
		expect(applyEdits("stay", edits).text).toBe("stay");
		expect(applyEdits("stay", edits).firstChangedLine).toBeUndefined();
	});
});
