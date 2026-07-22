/**
 * DEL each quarter of n=12 file independently.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth SWAP quarters", () => {
	const n = 12;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let q = 0; q < 4; q++) {
		const start = q * 3 + 1;
		const end = start + 2;
		it(`DEL quarter ${q + 1} lines ${start}.=${end}`, () => {
			const { text } = applyEdits(base, parsePatch(`DEL ${start}.=${end}`).edits);
			const want = [...lines.slice(0, start - 1), ...lines.slice(end)];
			expect(text.split("\n")).toEqual(want);
		});
	}
});
