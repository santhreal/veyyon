import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequentially SWAP every line in a file one at a time.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("sequential SWAP of every line", () => {
	it("each line becomes Xi after i sequential SWAPs", () => {
		const n = 8;
		let cur = text(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		for (let i = 1; i <= n; i++) {
			cur = apply(cur, `SWAP ${i}.=${i}:\n+X${i}`);
		}
		const result = cur.split("\n").filter((l, i, a) => i < a.length - 1 || l);
		expect(result).toEqual(Array.from({ length: n }, (_, i) => `X${i + 1}`));
	});
});
