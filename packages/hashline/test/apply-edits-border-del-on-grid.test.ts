/**
 * 5x5 grid as 25 lines: DEL border cells, keep interior 3x3.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits border DEL on grid", () => {
	it("5x5 keep interior", () => {
		const side = 5;
		const n = side * side;
		const lines = Array.from({ length: n }, (_, i) => `C${i}`);
		const base = lines.join("\n");
		const dels: string[] = [];
		for (let r = 0; r < side; r++) {
			for (let c = 0; c < side; c++) {
				const border = r === 0 || c === 0 || r === side - 1 || c === side - 1;
				if (border) dels.push(`DEL ${r * side + c + 1}`);
			}
		}
		const { text } = applyEdits(base, parsePatch(dels.join("\n")).edits);
		const want: string[] = [];
		for (let r = 1; r < side - 1; r++) {
			for (let c = 1; c < side - 1; c++) {
				want.push(`C${r * side + c}`);
			}
		}
		expect(text.split("\n")).toEqual(want);
	});
});
