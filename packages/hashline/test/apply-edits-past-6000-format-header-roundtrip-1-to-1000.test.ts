/**
 * formatDeleteHeader / formatReplaceHeader round-trip for 1..1000.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 format header roundtrip 1 to 1000", () => {
	const n = 1000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`DEL ${i}`, () => {
			const { firstChangedLine } = applyEdits(base, parsePatch(formatDeleteHeader(i)).edits);
			expect(firstChangedLine).toBe(i);
		});

		it(`SWAP ${i}`, () => {
			const header = formatReplaceHeader(i, i);
			const { text } = applyEdits(base, parsePatch(`${header}\n+Z${i}`).edits);
			expect(text.split("\n")[i - 1]).toBe(`Z${i}`);
		});
	}
});
