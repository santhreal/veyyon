import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Expand the last line into many lines.
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

describe("SWAP expand last line", () => {
	it("expands last line to k lines for k=1..8", () => {
		const src = text(["A", "B", "C"]);
		for (let k = 1; k <= 8; k++) {
			const body = Array.from({ length: k }, (_, i) => `+L${i}`).join("\n");
			const out = apply(src, `SWAP 3.=3:\n${body}`);
			expect(count(out)).toBe(2 + k);
			expect(out.startsWith("A\nB\n")).toBe(true);
		}
	});
});
