import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP start..=end for all ranges in a 5-line file with single-line replacement.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const SRC = text(["1", "2", "3", "4", "5"]);

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

function count(s: string): number {
	if (s === "" || s === "\n") return 0;
	return s.replace(/\n$/, "").split("\n").length;
}

describe("SWAP range endpoint matrix", () => {
	it("SWAP s..=e with one line leaves 6-(e-s) lines", () => {
		for (let s = 1; s <= 5; s++) {
			for (let e = s; e <= 5; e++) {
				const out = apply(`SWAP ${s}.=${e}:\n+X`);
				const expected = 5 - (e - s);
				expect(count(out)).toBe(expected);
				expect(out).toContain("X");
			}
		}
	});
});
