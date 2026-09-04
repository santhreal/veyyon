import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Multi-line INS.HEAD then SWAP of one of the inserted lines.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("INS.HEAD multi then SWAP", () => {
	it("inserts two lines then renames the first", () => {
		let cur = text(["body"]);
		cur = apply(cur, "INS.HEAD:\n+H1\n+H2");
		expect(cur).toBe(text(["H1", "H2", "body"]));
		cur = apply(cur, "SWAP 1.=1:\n+H1x");
		expect(cur).toBe(text(["H1x", "H2", "body"]));
	});
});
