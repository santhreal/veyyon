/**
 * DEL all odds / all evens of files size 2..10.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL odds and evens", () => {
	for (const n of [2, 4, 6, 8, 10]) {
		it(`n=${n} DEL all evens`, () => {
			const text = Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");
			const dels = Array.from({ length: n / 2 }, (_, i) => `DEL ${2 * (i + 1)}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(dels).edits);
			const want = Array.from({ length: n / 2 }, (_, i) => String(2 * i + 1)).join("\n");
			expect(out).toBe(want);
		});
		it(`n=${n} DEL all odds`, () => {
			const text = Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");
			const dels = Array.from({ length: n / 2 }, (_, i) => `DEL ${2 * i + 1}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(dels).edits);
			const want = Array.from({ length: n / 2 }, (_, i) => String(2 * (i + 1))).join("\n");
			expect(out).toBe(want);
		});
	}
});
