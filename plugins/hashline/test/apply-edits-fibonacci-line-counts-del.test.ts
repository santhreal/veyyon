/**
 * Files with Fibonacci lengths: DEL first and last leave middle.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits fibonacci line counts DEL", () => {
	const fibs = [5, 8, 13, 21];
	for (const n of fibs) {
		it(`n=${n} DEL first and last`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const { text } = applyEdits(base, parsePatch(`DEL 1\nDEL ${n}`).edits);
			expect(text.split("\n")).toEqual(lines.slice(1, -1));
		});
	}
});
