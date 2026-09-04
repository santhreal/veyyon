import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * SWAP N.=M matrix: replace ranges with fixed replacement lines.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const SRC = text(Array.from({ length: 8 }, (_, i) => `L${i + 1}`));

describe("SWAP range matrix", () => {
	it("SWAP N.=N replaces a single line for each N", () => {
		for (let n = 1; n <= 8; n++) {
			const out = applyEdits(SRC, parsePatch(`SWAP ${n}.=${n}:\n+X${n}`).edits).text;
			const lines = out.split("\n").filter((l, i, a) => i < a.length - 1 || l);
			expect(lines[n - 1]).toBe(`X${n}`);
			expect(lines).toHaveLength(8);
		}
	});

	it("SWAP 2.=4 replaces three lines with one", () => {
		const out = applyEdits(SRC, parsePatch("SWAP 2.=4:\n+MID").edits).text;
		expect(out).toBe(text(["L1", "MID", "L5", "L6", "L7", "L8"]));
	});

	it("SWAP 1.=1 with multi-line body expands the file", () => {
		const out = applyEdits(SRC, parsePatch("SWAP 1.=1:\n+A\n+B\n+C").edits).text;
		expect(out.startsWith("A\nB\nC\n")).toBe(true);
		expect(out).toContain("L2");
	});
});
