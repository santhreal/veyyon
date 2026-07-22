import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP adjacent pairs across a file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("SWAP adjacent line pairs", () => {
	it("swaps each adjacent pair sequentially", () => {
		// Start: 1 2 3 4
		// Swap 1-2 → A B 3 4
		// Swap 3-4 → A B C D
		let cur = text(["1", "2", "3", "4"]);
		cur = apply(cur, "SWAP 1.=2:\n+A\n+B");
		expect(cur).toBe(text(["A", "B", "3", "4"]));
		cur = apply(cur, "SWAP 3.=4:\n+C\n+D");
		expect(cur).toBe(text(["A", "B", "C", "D"]));
	});
});
