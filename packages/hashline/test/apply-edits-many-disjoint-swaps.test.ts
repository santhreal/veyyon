import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Many disjoint single-line SWAPs in one patch.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("many disjoint SWAPs", () => {
	it("swaps every other line in a 20-line file", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
		const src = text(lines);
		const hunks = Array.from({ length: 10 }, (_, i) => {
			const n = i * 2 + 1;
			return `SWAP ${n}.=${n}:\n+X${n}`;
		}).join("\n");
		const out = applyEdits(src, parsePatch(hunks).edits).text;
		const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result).toHaveLength(20);
		for (let i = 0; i < 10; i++) {
			const n = i * 2 + 1;
			expect(result[n - 1]).toBe(`X${n}`);
			expect(result[n]).toBe(`L${n + 1}`);
		}
	});
});
