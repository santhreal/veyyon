/**
 * computeFileHash is stable under identity SWAP cycles on concrete lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits property hash stable under identity ops", () => {
	const bodies = ["a\nb\nc", "x", "unicode ☃", "line1\nline2"];

	for (const base of bodies) {
		it(`identity cycle ${JSON.stringify(base)}`, () => {
			const h0 = computeFileHash(base);
			const lines = base.split("\n");
			let t = base;
			for (let i = 0; i < lines.length; i++) {
				const line = i + 1;
				t = applyEdits(
					t,
					parsePatch(`SWAP ${line}.=${line}:\n+${lines[i]}`).edits,
				).text;
			}
			expect(t).toBe(base);
			expect(computeFileHash(t)).toBe(h0);
		});
	}

	it("empty stays empty hash", () => {
		const h = computeFileHash("");
		expect(computeFileHash(applyEdits("", []).text)).toBe(h);
	});
});
