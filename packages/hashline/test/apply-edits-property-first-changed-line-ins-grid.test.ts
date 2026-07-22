/**
 * firstChangedLine for inserts: HEAD→1; PRE/POST report the anchor line;
 * TAIL reports n+1 for n-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits firstChangedLine INS grid", () => {
	const base = "a\nb\nc\nd\ne";

	it("INS.HEAD → 1", () => {
		expect(applyEdits(base, parsePatch("INS.HEAD:\n+H").edits).firstChangedLine).toBe(1);
	});

	it("INS.TAIL → 6 on 5-line file", () => {
		expect(applyEdits(base, parsePatch("INS.TAIL:\n+T").edits).firstChangedLine).toBe(6);
	});

	for (let a = 1; a <= 5; a++) {
		it(`INS.POST ${a} firstChangedLine is anchor ${a}`, () => {
			const r = applyEdits(base, parsePatch(`INS.POST ${a}:\n+X`).edits);
			expect(r.firstChangedLine).toBe(a);
		});

		it(`INS.PRE ${a} firstChangedLine is ${a}`, () => {
			const r = applyEdits(base, parsePatch(`INS.PRE ${a}:\n+X`).edits);
			expect(r.firstChangedLine).toBe(a);
		});
	}
});
