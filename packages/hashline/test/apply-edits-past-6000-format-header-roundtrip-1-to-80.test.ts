/**
 * formatDeleteHeader / formatReplaceHeader round-trip parse+apply for 1..80.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 format header roundtrip 1 to 80", () => {
	const n = 80;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let i = 1; i <= n; i++) {
		it(`DEL format ${i}`, () => {
			const header = formatDeleteHeader(i);
			expect(header).toBe(`DEL ${i}`);
			const { text } = applyEdits(base, parsePatch(header).edits);
			expect(text === "" ? [] : text.split("\n")).toEqual(lines.filter((_, j) => j + 1 !== i));
		});

		it(`SWAP format ${i}`, () => {
			const header = formatReplaceHeader(i, i);
			expect(header).toBe(`SWAP ${i}.=${i}:`);
			const { text } = applyEdits(base, parsePatch(`${header}\n+Z${i}`).edits);
			expect(text.split("\n")[i - 1]).toBe(`Z${i}`);
		});
	}
});
