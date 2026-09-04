/**
 * DEL first half vs last half vs middle half on even n.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth DEL half variants", () => {
	for (const n of [6, 10, 20]) {
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const half = n / 2;

		it(`n=${n} first half`, () => {
			const { text } = applyEdits(base, parsePatch(`DEL 1.=${half}`).edits);
			expect(text.split("\n")).toEqual(lines.slice(half));
		});

		it(`n=${n} last half`, () => {
			const { text } = applyEdits(base, parsePatch(`DEL ${half + 1}.=${n}`).edits);
			expect(text.split("\n")).toEqual(lines.slice(0, half));
		});
	}
});
