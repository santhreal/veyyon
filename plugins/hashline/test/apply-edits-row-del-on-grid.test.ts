/**
 * 5x4 grid (20 lines): DEL entire row r=2 (0-based).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits row DEL on grid", () => {
	it("5 rows 4 cols DEL row 2", () => {
		const rows = 5;
		const cols = 4;
		const lines = Array.from({ length: rows * cols }, (_, i) => `C${i}`);
		const base = lines.join("\n");
		const row = 2;
		const start = row * cols + 1;
		const end = start + cols - 1;
		const { text } = applyEdits(base, parsePatch(`DEL ${start}.=${end}`).edits);
		const want: string[] = [];
		for (let r = 0; r < rows; r++) {
			if (r === row) continue;
			for (let c = 0; c < cols; c++) want.push(`C${r * cols + c}`);
		}
		expect(text.split("\n")).toEqual(want);
	});
});
