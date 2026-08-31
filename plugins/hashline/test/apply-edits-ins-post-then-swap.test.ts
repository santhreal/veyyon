import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * INS.POST then SWAP of the inserted line.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("INS.POST then SWAP inserted", () => {
	it("insert after first then rename the insert", () => {
		let cur = text(["A", "B"]);
		cur = apply(cur, "INS.POST 1:\n+X");
		expect(cur).toBe(text(["A", "X", "B"]));
		cur = apply(cur, "SWAP 2.=2:\n+X2");
		expect(cur).toBe(text(["A", "X2", "B"]));
	});
});
