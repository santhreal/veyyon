import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Expand middle of file with multi-line SWAP for several sizes.
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

describe("SWAP middle expand many", () => {
	it("replaces middle line with k lines for k=1..10", () => {
		const src = text(["A", "B", "C"]);
		for (let k = 1; k <= 10; k++) {
			const body = Array.from({ length: k }, (_, i) => `+M${i}`).join("\n");
			const out = apply(src, `SWAP 2.=2:\n${body}`);
			expect(count(out)).toBe(2 + k);
			expect(out.startsWith("A\n")).toBe(true);
			expect(out.endsWith("C\n") || out.includes("\nC\n") || out.trimEnd().endsWith("C")).toBe(
				true,
			);
		}
	});
});
