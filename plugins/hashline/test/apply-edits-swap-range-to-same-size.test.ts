import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP ranges replaced with same number of lines.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

function count(s: string): number {
	if (s === "" || s === "\n") return 0;
	return s.replace(/\n$/, "").split("\n").length;
}

describe("SWAP range same size", () => {
	it("replace 3 lines with 3 lines preserves total count", () => {
		const src = text(["A", "B", "C", "D", "E"]);
		const out = apply(src, "SWAP 2.=4:\n+X\n+Y\n+Z");
		expect(count(out)).toBe(5);
		expect(out).toBe(text(["A", "X", "Y", "Z", "E"]));
	});

	it("replace 2 lines with 2 lines", () => {
		const src = text(["A", "B", "C"]);
		const out = apply(src, "SWAP 1.=2:\n+X\n+Y");
		expect(out).toBe(text(["X", "Y", "C"]));
	});
});
