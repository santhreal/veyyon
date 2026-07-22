import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Two non-adjacent 2-line SWAPs in one patch.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("two nonadjacent pair SWAPs", () => {
	it("swaps 1-2 and 5-6 in a 6-line file", () => {
		const src = text(["1", "2", "3", "4", "5", "6"]);
		const out = apply(src, "SWAP 1.=2:\n+A\n+B\nSWAP 5.=6:\n+E\n+F");
		expect(out).toBe(text(["A", "B", "3", "4", "E", "F"]));
	});
});
