import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * DEL ranges of various sizes from a fixed 20-line file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const SRC = text(Array.from({ length: 20 }, (_, i) => `L${i + 1}`));

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

function count(s: string): number {
	if (s === "" || s === "\n") return 0;
	return s.replace(/\n$/, "").split("\n").length;
}

describe("DEL range sizes", () => {
	it("DEL 1..=k leaves 20-k lines for k=1..20", () => {
		for (let k = 1; k <= 20; k++) {
			const out = apply(`DEL 1.=${k}`);
			expect(count(out)).toBe(20 - k);
			if (k < 20) {
				expect(out).toContain(`L${k + 1}`);
			}
		}
	});
});
