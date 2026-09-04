/**
 * formatInsertHeader exact string matrix for all cursor kinds and lines 1..5.
 */
import { describe, expect, it } from "bun:test";
import { formatInsertHeader } from "@veyyon/hashline";

describe("formatInsertHeader exact strings", () => {
	it("bof and eof fixed", () => {
		expect(formatInsertHeader({ kind: "bof" })).toBe("INS.HEAD:");
		expect(formatInsertHeader({ kind: "eof" })).toBe("INS.TAIL:");
	});

	for (let line = 1; line <= 5; line++) {
		it(`PRE ${line}`, () => {
			expect(formatInsertHeader({ kind: "before_anchor", anchor: { line } })).toBe(`INS.PRE ${line}:`);
		});
		it(`POST ${line}`, () => {
			expect(formatInsertHeader({ kind: "after_anchor", anchor: { line } })).toBe(`INS.POST ${line}:`);
		});
	}
});
