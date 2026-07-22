/**
 * Sequential SWAP of the same line index with different bodies: last write wins.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits SWAP then SWAP same line sequential", () => {
	it("last write wins on line 2", () => {
		let t = "a\nb\nc";
		t = apply(t, "SWAP 2.=2:\n+X");
		expect(t).toBe("a\nX\nc");
		t = apply(t, "SWAP 2.=2:\n+Y");
		expect(t).toBe("a\nY\nc");
		t = apply(t, "SWAP 2.=2:\n+Z");
		expect(t).toBe("a\nZ\nc");
	});

	for (let line = 1; line <= 4; line++) {
		it(`line ${line} chain A→B`, () => {
			const base = "w\nx\ny\nz";
			let t = apply(base, `SWAP ${line}.=${line}:\n+A`);
			t = apply(t, `SWAP ${line}.=${line}:\n+B`);
			const out = t.split("\n");
			expect(out[line - 1]).toBe("B");
		});
	}
});
