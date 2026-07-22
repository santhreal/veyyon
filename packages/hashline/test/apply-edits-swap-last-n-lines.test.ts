import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP last N lines of a file with a single marker line.
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

describe("SWAP last N lines", () => {
	it("collapses last k lines to one for k=1..10 on a 10-line file", () => {
		const n = 10;
		const src = text(Array.from({ length: n }, (_, i) => `L${i + 1}`));
		for (let k = 1; k <= n; k++) {
			const start = n - k + 1;
			const out = apply(src, `SWAP ${start}.=${n}:\n+TAIL`);
			expect(count(out)).toBe(n - k + 1);
			expect(out.trimEnd().endsWith("TAIL")).toBe(true);
			if (start > 1) {
				expect(out).toContain(`L${start - 1}`);
			}
		}
	});
});
