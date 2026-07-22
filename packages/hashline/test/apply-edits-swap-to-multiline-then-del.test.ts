import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Expand then delete in sequential pure applies.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("expand then DEL sequence", () => {
	it("expand middle then delete first of expansion", () => {
		let cur = text(["A", "B", "C"]);
		cur = apply(cur, "SWAP 2.=2:\n+X\n+Y\n+Z");
		expect(cur).toBe(text(["A", "X", "Y", "Z", "C"]));
		cur = apply(cur, "DEL 2.=2");
		expect(cur).toBe(text(["A", "Y", "Z", "C"]));
	});
});
