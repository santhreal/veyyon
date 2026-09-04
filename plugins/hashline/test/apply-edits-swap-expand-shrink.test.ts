import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP expands and shrinks ranges (1→N and N→1).
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

describe("SWAP expand and shrink", () => {
	it("1→3 expand", () => {
		const out = apply(text(["A", "B", "C"]), "SWAP 2.=2:\n+X\n+Y\n+Z");
		expect(count(out)).toBe(5);
		expect(out).toBe(text(["A", "X", "Y", "Z", "C"]));
	});

	it("3→1 shrink", () => {
		const out = apply(text(["A", "B", "C", "D"]), "SWAP 2.=4:\n+MID");
		expect(count(out)).toBe(2);
		expect(out).toBe(text(["A", "MID"]));
	});

	it("2→2 same count", () => {
		const out = apply(text(["A", "B", "C"]), "SWAP 1.=2:\n+X\n+Y");
		expect(count(out)).toBe(3);
		expect(out).toBe(text(["X", "Y", "C"]));
	});

	it("full file 5→1", () => {
		const out = apply(text(["A", "B", "C", "D", "E"]), "SWAP 1.=5:\n+ALL");
		expect(out).toBe(text(["ALL"]));
	});
});
