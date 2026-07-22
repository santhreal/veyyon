import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Delete from the end of the file repeatedly.
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

describe("sequential DEL from end", () => {
	it("deleting last line repeatedly empties the file", () => {
		const n = 7;
		let cur = text(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		for (let left = n; left >= 1; left--) {
			cur = apply(cur, `DEL ${left}.=${left}`);
			expect(count(cur)).toBe(left - 1);
		}
		expect(cur === "" || cur === "\n").toBe(true);
	});
});
