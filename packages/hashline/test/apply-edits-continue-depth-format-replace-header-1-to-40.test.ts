/**
 * formatReplaceHeader(i,i) → parse → apply SWAP line i for i=1..40 on n=40.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth format replace header 1 to 40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`formatReplaceHeader(${i},${i})`, () => {
			const h = formatReplaceHeader(i, i);
			const { text } = applyEdits(base, parsePatch(`${h}\n+X${i}`).edits);
			expect(text.split("\n")[i - 1]).toBe(`X${i}`);
			expect(text.split("\n")).toHaveLength(n);
		});
	}
});
