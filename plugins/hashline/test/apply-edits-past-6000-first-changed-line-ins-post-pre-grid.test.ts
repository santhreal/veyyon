/**
 * firstChangedLine for INS.POST/PRE at every anchor on n=30.
 * Why: POST/PRE report the anchor line as first changed (insert after/before).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 firstChangedLine INS POST PRE grid", () => {
	const n = 30;
	const base = Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");

	for (let a = 1; a <= n; a++) {
		it(`POST ${a} firstChangedLine=${a}`, () => {
			const r = applyEdits(base, parsePatch(`INS.POST ${a}:\n+X`).edits);
			expect(r.firstChangedLine).toBe(a);
			expect(r.text.split("\n")[a]).toBe("X");
		});

		it(`PRE ${a} firstChangedLine=${a}`, () => {
			const r = applyEdits(base, parsePatch(`INS.PRE ${a}:\n+X`).edits);
			expect(r.firstChangedLine).toBe(a);
			expect(r.text.split("\n")[a - 1]).toBe("X");
		});
	}

	it("HEAD firstChangedLine 1", () => {
		expect(applyEdits(base, parsePatch("INS.HEAD:\n+H").edits).firstChangedLine).toBe(1);
	});

	it("TAIL firstChangedLine is new last line (n+1)", () => {
		const r = applyEdits(base, parsePatch("INS.TAIL:\n+T").edits);
		expect(r.firstChangedLine).toBe(n + 1);
		expect(r.text.split("\n")[n]).toBe("T");
	});
});
