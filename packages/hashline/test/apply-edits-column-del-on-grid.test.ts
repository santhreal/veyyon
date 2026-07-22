/**
 * 4x5 grid (20 lines): DEL entire column c=2 (0-based).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits column DEL on grid", () => {
	it("4 rows 5 cols DEL col 2", () => {
		const rows = 4;
		const cols = 5;
		const lines = Array.from({ length: rows * cols }, (_, i) => `C${i}`);
		const base = lines.join("\n");
		const col = 2;
		const dels: string[] = [];
		for (let r = 0; r < rows; r++) {
			dels.push(`DEL ${r * cols + col + 1}`);
		}
		const { text } = applyEdits(base, parsePatch(dels.join("\n")).edits);
		const want: string[] = [];
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				if (c !== col) want.push(`C${r * cols + c}`);
			}
		}
		expect(text.split("\n")).toEqual(want);
	});
});
