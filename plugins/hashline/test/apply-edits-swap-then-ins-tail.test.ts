import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequential SWAP then INS.TAIL.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP then INS.TAIL", () => {
	it("swap first then append", () => {
		let cur = text(["A", "B"]);
		cur = apply(cur, "SWAP 1.=1:\n+A2");
		cur = apply(cur, "INS.TAIL:\n+C");
		expect(cur).toBe(text(["A2", "B", "C"]));
	});

	it("swap last then append", () => {
		let cur = text(["A", "B"]);
		cur = apply(cur, "SWAP 2.=2:\n+B2");
		cur = apply(cur, "INS.TAIL:\n+C");
		expect(cur).toBe(text(["A", "B2", "C"]));
	});
});
