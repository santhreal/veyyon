import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP multi-line block to multi-line block of different sizes.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP block to block", () => {
	it("2 lines → 4 lines", () => {
		const out = apply(text(["A", "B", "C", "D"]), "SWAP 2.=3:\n+W\n+X\n+Y\n+Z");
		expect(out).toBe(text(["A", "W", "X", "Y", "Z", "D"]));
	});

	it("4 lines → 2 lines", () => {
		const out = apply(text(["A", "B", "C", "D", "E", "F"]), "SWAP 2.=5:\n+X\n+Y");
		expect(out).toBe(text(["A", "X", "Y", "F"]));
	});

	it("3 lines → 3 lines", () => {
		const out = apply(text(["A", "B", "C", "D"]), "SWAP 1.=3:\n+X\n+Y\n+Z");
		expect(out).toBe(text(["X", "Y", "Z", "D"]));
	});
});
