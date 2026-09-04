import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP first N lines of a file with a single marker line.
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

describe("SWAP first N lines", () => {
	it("collapses first k lines to one for k=1..10 on a 10-line file", () => {
		const src = text(Array.from({ length: 10 }, (_, i) => `L${i + 1}`));
		for (let k = 1; k <= 10; k++) {
			const out = apply(src, `SWAP 1.=${k}:\n+HEAD`);
			expect(count(out)).toBe(10 - k + 1);
			expect(out.startsWith("HEAD\n")).toBe(true);
			if (k < 10) {
				expect(out).toContain(`L${k + 1}`);
			}
		}
	});
});
