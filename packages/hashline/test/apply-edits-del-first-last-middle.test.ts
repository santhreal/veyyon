/**
 * DEL first, last, middle on files of size 1..8 with exact remaining text.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function body(n: number): string {
	return Array.from({ length: n }, (_, i) => String(i + 1)).join("\n");
}

describe("applyEdits DEL first/last/middle by file size", () => {
	for (const n of [1, 2, 3, 5, 8]) {
		it(`n=${n} DEL first`, () => {
			const { text } = applyEdits(body(n), parsePatch("DEL 1").edits);
			const want = Array.from({ length: n - 1 }, (_, i) => String(i + 2));
			expect(text).toBe(want.join("\n"));
		});
		if (n >= 2) {
			it(`n=${n} DEL last`, () => {
				const { text } = applyEdits(body(n), parsePatch(`DEL ${n}`).edits);
				const want = Array.from({ length: n - 1 }, (_, i) => String(i + 1));
				expect(text).toBe(want.join("\n"));
			});
		}
		if (n >= 3) {
			const mid = Math.ceil(n / 2);
			it(`n=${n} DEL mid=${mid}`, () => {
				const { text } = applyEdits(body(n), parsePatch(`DEL ${mid}`).edits);
				const want = Array.from({ length: n }, (_, i) => String(i + 1)).filter(
					(_, i) => i + 1 !== mid,
				);
				expect(text).toBe(want.join("\n"));
			});
		}
	}
});
