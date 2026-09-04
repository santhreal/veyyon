import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequential INS.POST after each original line (applied one at a time).
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("INS.POST sequential between lines", () => {
	it("insert after each of 3 lines via sequential applies", () => {
		let cur = text(["A", "B", "C"]);
		// After A
		cur = apply(cur, "INS.POST 1:\n+x");
		expect(cur).toBe(text(["A", "x", "B", "C"]));
		// After B (now line 3)
		cur = apply(cur, "INS.POST 3:\n+y");
		expect(cur).toBe(text(["A", "x", "B", "y", "C"]));
		// After C (now line 5)
		cur = apply(cur, "INS.POST 5:\n+z");
		expect(cur).toBe(text(["A", "x", "B", "y", "C", "z"]));
	});
});
