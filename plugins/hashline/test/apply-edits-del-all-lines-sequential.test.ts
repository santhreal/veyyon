import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Delete all lines one by one from the front.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("sequential DEL from front", () => {
	it("deleting line 1 repeatedly empties an N-line file", () => {
		for (const n of [1, 3, 5, 10]) {
			let cur = text(Array.from({ length: n }, (_, i) => `L${i}`));
			for (let i = 0; i < n; i++) {
				cur = apply(cur, "DEL 1.=1");
			}
			expect(cur === "" || cur === "\n").toBe(true);
		}
	});
});
