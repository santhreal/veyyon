import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * DEL middle ranges of various widths from a 15-line file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const SRC = text(Array.from({ length: 15 }, (_, i) => `L${i + 1}`));

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

function count(s: string): number {
	if (s === "" || s === "\n") return 0;
	return s.replace(/\n$/, "").split("\n").length;
}

describe("DEL middle range sizes", () => {
	it("DEL starting at 5 with width w leaves 15-w lines", () => {
		for (let w = 1; w <= 10; w++) {
			const end = 4 + w;
			const out = apply(`DEL 5.=${end}`);
			expect(count(out)).toBe(15 - w);
			expect(out).toContain("L4");
			if (end < 15) {
				expect(out).toContain(`L${end + 1}`);
			}
		}
	});
});
