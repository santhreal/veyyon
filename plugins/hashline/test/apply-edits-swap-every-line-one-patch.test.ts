import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * One patch swapping every line of an N-line file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("SWAP every line one patch", () => {
	it("all lines replaced for n=5 and n=10", () => {
		for (const n of [5, 10]) {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const src = text(lines);
			const hunks = lines.map((_, i) => `SWAP ${i + 1}.=${i + 1}:\n+X${i + 1}`).join("\n");
			const out = applyEdits(src, parsePatch(hunks).edits).text;
			const result = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(result).toEqual(Array.from({ length: n }, (_, i) => `X${i + 1}`));
		}
	});
});
