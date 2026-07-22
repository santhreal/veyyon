/**
 * 4x4 grid: SWAP anti-diagonal cells.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits anti-diagonal SWAP on grid", () => {
	it("4x4 anti-diagonal", () => {
		const side = 4;
		const lines = Array.from({ length: side * side }, (_, i) => `C${i}`);
		const base = lines.join("\n");
		const hunks: string[] = [];
		for (let i = 0; i < side; i++) {
			const line = i * side + (side - 1 - i) + 1;
			hunks.push(`SWAP ${line}.=${line}:\n+A${i}`);
		}
		const { text } = applyEdits(base, parsePatch(hunks.join("\n")).edits);
		const out = text.split("\n");
		for (let i = 0; i < side; i++) {
			expect(out[i * side + (side - 1 - i)]).toBe(`A${i}`);
		}
	});
});
