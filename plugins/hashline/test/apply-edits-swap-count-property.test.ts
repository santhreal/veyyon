import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * After k single-line SWAPs in one patch, line count is unchanged.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function count(s: string): number {
	if (s === "" || s === "\n") return 0;
	return s.replace(/\n$/, "").split("\n").length;
}

describe("SWAP count property", () => {
	it("k disjoint single-line SWAPs preserve length for n=10..30", () => {
		for (const n of [10, 15, 20, 30]) {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const src = text(lines);
			// Swap first k odd lines.
			const k = Math.floor(n / 2);
			const hunks = Array.from({ length: k }, (_, i) => {
				const line = i * 2 + 1;
				return `SWAP ${line}.=${line}:\n+X${line}`;
			}).join("\n");
			const out = applyEdits(src, parsePatch(hunks).edits).text;
			expect(count(out)).toBe(n);
		}
	});
});
