import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * DEL then INS.HEAD sequence.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("DEL then INS.HEAD", () => {
	it("delete first then prepend", () => {
		let cur = text(["A", "B", "C"]);
		cur = apply(cur, "DEL 1.=1");
		expect(cur).toBe(text(["B", "C"]));
		cur = apply(cur, "INS.HEAD:\n+H");
		expect(cur).toBe(text(["H", "B", "C"]));
	});
});
