/**
 * DEL lines where (i % m) === 0 for m in 2..5 on n=24 file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits modulo DEL pattern", () => {
	const n = 24;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (const m of [2, 3, 4, 5]) {
		it(`DEL i%${m}===0`, () => {
			const dels = Array.from({ length: n }, (_, i) => i + 1)
				.filter(i => i % m === 0)
				.map(i => `DEL ${i}`)
				.join("\n");
			const { text } = applyEdits(base, parsePatch(dels).edits);
			const want = lines.filter((_, i) => (i + 1) % m !== 0);
			expect(text.split("\n")).toEqual(want);
		});
	}
});
