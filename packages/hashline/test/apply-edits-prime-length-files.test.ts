/**
 * Prime-length files: DEL middle prime index.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits prime length files", () => {
	const primes = [3, 5, 7, 11, 13, 17, 19];
	for (const n of primes) {
		it(`n=${n} DEL middle`, () => {
			const mid = Math.ceil(n / 2);
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const { text } = applyEdits(base, parsePatch(`DEL ${mid}`).edits);
			const want = lines.filter((_, i) => i + 1 !== mid);
			expect(text.split("\n")).toEqual(want);
		});
	}
});
