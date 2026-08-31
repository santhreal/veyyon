import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Collapse entire file to one line via SWAP 1.=N.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP all lines to one", () => {
	it("collapses n-line files for n=1..15", () => {
		for (let n = 1; n <= 15; n++) {
			const src = text(Array.from({ length: n }, (_, i) => `L${i}`));
			const out = apply(src, `SWAP 1.=${n}:\n+ONLY`);
			expect(out).toBe(text(["ONLY"]));
		}
	});
});
