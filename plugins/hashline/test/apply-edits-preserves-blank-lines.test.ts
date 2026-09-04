import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Blank lines in the middle of a file are preserved when editing elsewhere.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits preserves blank lines", () => {
	it("SWAP first leaves interior blank intact", () => {
		const src = text(["A", "", "C"]);
		const out = apply(src, "SWAP 1.=1:\n+A2");
		expect(out).toBe(text(["A2", "", "C"]));
	});

	it("DEL last leaves interior blank intact", () => {
		const src = text(["A", "", "C"]);
		const out = apply(src, "DEL 3.=3");
		expect(out).toBe(text(["A", ""]));
	});

	it("INS.TAIL after file with trailing blank structure", () => {
		const src = text(["A", ""]);
		const out = apply(src, "INS.TAIL:\n+Z");
		expect(out).toContain("A");
		expect(out).toContain("Z");
	});
});
