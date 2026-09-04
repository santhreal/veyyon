/**
 * formatInsertHeader exact strings for every cursor kind × anchor lines.
 */
import { describe, expect, it } from "bun:test";
import { formatInsertHeader } from "@veyyon/hashline";

describe("formatInsertHeader all cursors exact", () => {
	it("bof and eof", () => {
		expect(formatInsertHeader({ kind: "bof" })).toBe("INS.HEAD:");
		expect(formatInsertHeader({ kind: "eof" })).toBe("INS.TAIL:");
	});

	for (let line = 1; line <= 20; line++) {
		it(`PRE/POST ${line}`, () => {
			expect(formatInsertHeader({ kind: "before_anchor", anchor: { line } })).toBe(`INS.PRE ${line}:`);
			expect(formatInsertHeader({ kind: "after_anchor", anchor: { line } })).toBe(`INS.POST ${line}:`);
		});
	}
});
