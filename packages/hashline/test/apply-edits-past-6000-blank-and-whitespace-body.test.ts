/**
 * Blank lines and whitespace-only body rows through DEL/SWAP/INS.
 * Why: empty payload lines and whitespace content must stay exact, not trimmed.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 blank and whitespace body", () => {
	it("file of blank lines survives identity", () => {
		const base = "\n\n\n";
		// 4 lines: empty, empty, empty, empty? "\n\n\n".split = ['','','','']
		const lines = base.split("\n");
		expect(lines).toHaveLength(4);
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+").edits);
		// empty body row after + may be empty string line
		const out = text.split("\n");
		expect(out).toHaveLength(4);
		expect(out[1]).toBe("");
	});

	it("INS.HEAD blank row inserts empty line", () => {
		const { text } = applyEdits("A", parsePatch("INS.HEAD:\n+").edits);
		expect(text).toBe("\nA");
	});

	it("whitespace-only body preserved on SWAP", () => {
		const { text } = applyEdits("x", parsePatch("SWAP 1.=1:\n+   ").edits);
		expect(text).toBe("   ");
	});

	it("tab body preserved", () => {
		const { text } = applyEdits("x", parsePatch("SWAP 1.=1:\n+\t\t").edits);
		expect(text).toBe("\t\t");
	});

	it("DEL blank line in middle", () => {
		const base = "A\n\nB";
		const { text } = applyEdits(base, parsePatch("DEL 2").edits);
		expect(text).toBe("A\nB");
	});

	it("INS.POST after blank", () => {
		const base = "A\n\nB";
		const { text } = applyEdits(base, parsePatch("INS.POST 2:\n+X").edits);
		expect(text).toBe("A\n\nX\nB");
	});

	for (let spaces = 1; spaces <= 10; spaces++) {
		it(`SWAP to ${spaces} spaces`, () => {
			const body = " ".repeat(spaces);
			const { text } = applyEdits("Z", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
