/**
 * DEL single line i for i=1..30 on n=30 file: length 29, missing that line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth DEL line 1 to 30", () => {
	const n = 30;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`DEL ${i}`, () => {
			const { text } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			const out = text.split("\n");
			expect(out).toHaveLength(n - 1);
			expect(out).not.toContain(`L${i}`);
		});
	}
});
