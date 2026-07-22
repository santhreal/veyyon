import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP the middle half of even-length files.
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

describe("SWAP middle half", () => {
	it("replaces middle half with MID for even n", () => {
		for (const n of [4, 6, 8, 10, 12]) {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const src = text(lines);
			const start = n / 2;
			const end = n / 2 + 1;
			// For n=4: lines 2-3; for n=6: lines 3-4
			const s = Math.floor(n / 2);
			const e = s + 1;
			const out = apply(src, `SWAP ${s}.=${e}:\n+MID`);
			expect(count(out)).toBe(n - 1);
			expect(out).toContain("MID");
			expect(out).toContain("L1");
			expect(out).toContain(`L${n}`);
		}
	});
});
