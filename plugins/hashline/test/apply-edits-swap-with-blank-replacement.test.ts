import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP introducing blank lines in the middle of a file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP introducing blank lines", () => {
	it("replaces middle with blank-containing block", () => {
		const out = apply(text(["A", "B", "C"]), "SWAP 2.=2:\n+\n+X\n+");
		expect(out).toContain("A");
		expect(out).toContain("X");
		expect(out).toContain("C");
	});

	it("replaces a line with only spaces", () => {
		const out = apply(text(["A", "B"]), "SWAP 1.=1:\n+   ");
		const lines = out.split("\n");
		expect(lines[0]).toBe("   ");
		expect(out).toContain("B");
	});
});
