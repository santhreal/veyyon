import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Repeated INS.PRE 1 inserts always before the original first line content.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("repeated INS.PRE 1", () => {
	it("each insert goes to the new front", () => {
		let cur = text(["body"]);
		cur = apply(cur, "INS.PRE 1:\n+A");
		expect(cur).toBe(text(["A", "body"]));
		cur = apply(cur, "INS.PRE 1:\n+B");
		expect(cur).toBe(text(["B", "A", "body"]));
		cur = apply(cur, "INS.PRE 1:\n+C");
		expect(cur).toBe(text(["C", "B", "A", "body"]));
	});
});
