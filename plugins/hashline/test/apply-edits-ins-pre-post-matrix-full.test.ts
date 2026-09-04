import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Full INS.PRE / INS.POST matrix on a 6-line file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const SRC = text(["1", "2", "3", "4", "5", "6"]);

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

function linesOf(s: string): string[] {
	return s.split("\n").filter((l, i, a) => i < a.length - 1 || l);
}

describe("INS.PRE / INS.POST full matrix on 6 lines", () => {
	it("INS.POST n places marker immediately after original line n", () => {
		for (let n = 1; n <= 6; n++) {
			const out = linesOf(apply(`INS.POST ${n}:\n+M`));
			expect(out[n]).toBe("M");
			expect(out).toHaveLength(7);
			expect(out[n - 1]).toBe(String(n));
		}
	});

	it("INS.PRE n places marker immediately before original line n", () => {
		for (let n = 1; n <= 6; n++) {
			const out = linesOf(apply(`INS.PRE ${n}:\n+M`));
			expect(out[n - 1]).toBe("M");
			expect(out).toHaveLength(7);
			expect(out[n]).toBe(String(n));
		}
	});
});
