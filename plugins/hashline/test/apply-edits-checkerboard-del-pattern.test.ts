/**
 * Checkerboard DEL on n×m virtual grid stored as n*m lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits checkerboard DEL pattern", () => {
	it("4x4 checkerboard del black squares", () => {
		const side = 4;
		const n = side * side;
		const lines = Array.from({ length: n }, (_, i) => `C${i}`);
		const base = lines.join("\n");
		// black squares: (r+c) even
		const dels: string[] = [];
		for (let r = 0; r < side; r++) {
			for (let c = 0; c < side; c++) {
				if ((r + c) % 2 === 0) {
					const line = r * side + c + 1;
					dels.push(`DEL ${line}`);
				}
			}
		}
		const { text } = applyEdits(base, parsePatch(dels.join("\n")).edits);
		const want: string[] = [];
		for (let r = 0; r < side; r++) {
			for (let c = 0; c < side; c++) {
				if ((r + c) % 2 === 1) want.push(`C${r * side + c}`);
			}
		}
		expect(text.split("\n")).toEqual(want);
	});
});
