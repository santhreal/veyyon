import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * INS.POST between each consecutive pair of a short list.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("INS.POST between pairs", () => {
	it("interleaves separators between A B C via sequential posts", () => {
		let cur = text(["A", "B", "C"]);
		// After A (line 1)
		cur = apply(cur, "INS.POST 1:\n+-");
		// After B (now line 3)
		cur = apply(cur, "INS.POST 3:\n+-");
		expect(cur).toBe(text(["A", "-", "B", "-", "C"]));
	});
});
