import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * INS.POST / INS.PRE matrix on a 5-line file.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const SRC = text(["A", "B", "C", "D", "E"]);

function apply(diff: string): string {
	return applyEdits(SRC, parsePatch(diff).edits).text;
}

describe("INS.POST and INS.PRE matrix", () => {
	it("INS.POST N inserts after line N for N=1..5", () => {
		for (let n = 1; n <= 5; n++) {
			const out = apply(`INS.POST ${n}:\n+X`);
			const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(lines[n]).toBe("X");
			expect(lines).toContain("A");
			expect(lines).toHaveLength(6);
		}
	});

	it("INS.PRE N inserts before line N for N=1..5", () => {
		for (let n = 1; n <= 5; n++) {
			const out = apply(`INS.PRE ${n}:\n+Y`);
			const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(lines[n - 1]).toBe("Y");
			expect(lines).toHaveLength(6);
		}
	});
});
