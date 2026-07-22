import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * applyEdits with very long replacement lines.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits long line bodies", () => {
	it("SWAP with 5k-char line", () => {
		const long = "x".repeat(5000);
		const out = apply(text(["short"]), `SWAP 1.=1:\n+${long}`);
		expect(out).toBe(text([long]));
		expect(out.length).toBe(5001);
	});

	it("INS.TAIL with 2k-char line", () => {
		const long = "y".repeat(2000);
		const out = apply(text(["a"]), `INS.TAIL:\n+${long}`);
		expect(out).toBe(text(["a", long]));
	});
});
