import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * Sequential INS then SWAP pure chains.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("INS then SWAP chain", () => {
	it("INS.HEAD then SWAP of new first line", () => {
		const mid = apply(text(["A", "B"]), "INS.HEAD:\n+H");
		expect(mid).toBe(text(["H", "A", "B"]));
		const next = apply(mid, "SWAP 1.=1:\n+H2");
		expect(next).toBe(text(["H2", "A", "B"]));
	});

	it("INS.TAIL then SWAP of new last line", () => {
		const mid = apply(text(["A", "B"]), "INS.TAIL:\n+T");
		expect(mid).toBe(text(["A", "B", "T"]));
		const next = apply(mid, "SWAP 3.=3:\n+T2");
		expect(next).toBe(text(["A", "B", "T2"]));
	});

	it("INS.POST 1 then SWAP of the inserted line", () => {
		const mid = apply(text(["A", "B"]), "INS.POST 1:\n+X");
		expect(mid).toBe(text(["A", "X", "B"]));
		const next = apply(mid, "SWAP 2.=2:\n+X2");
		expect(next).toBe(text(["A", "X2", "B"]));
	});

	it("INS.PRE 1 then body is shifted", () => {
		const mid = apply(text(["A", "B"]), "INS.PRE 1:\n+Y");
		expect(mid).toBe(text(["Y", "A", "B"]));
	});
});
