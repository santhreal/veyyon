/**
 * formatInsertHeader for head/tail/before/after round-trips through parse+apply.
 * Why: formatter is the only owner of insert header strings used by tools.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatInsertHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 format insert header roundtrip", () => {
	const base = "A\nB\nC";

	it("HEAD", () => {
		const h = formatInsertHeader({ kind: "bof" });
		expect(h).toBe("INS.HEAD:");
		const { text } = applyEdits(base, parsePatch(`${h}\n+X`).edits);
		expect(text).toBe("X\nA\nB\nC");
	});

	it("TAIL", () => {
		const h = formatInsertHeader({ kind: "eof" });
		expect(h).toBe("INS.TAIL:");
		const { text } = applyEdits(base, parsePatch(`${h}\n+X`).edits);
		expect(text).toBe("A\nB\nC\nX");
	});

	for (let line = 1; line <= 3; line++) {
		it(`PRE line ${line}`, () => {
			const h = formatInsertHeader({ kind: "before_anchor", anchor: { line } });
			expect(h).toBe(`INS.PRE ${line}:`);
			const { text } = applyEdits(base, parsePatch(`${h}\n+X`).edits);
			const out = text.split("\n");
			expect(out[line - 1]).toBe("X");
		});

		it(`POST line ${line}`, () => {
			const h = formatInsertHeader({ kind: "after_anchor", anchor: { line } });
			expect(h).toBe(`INS.POST ${line}:`);
			const { text } = applyEdits(base, parsePatch(`${h}\n+X`).edits);
			const out = text.split("\n");
			expect(out[line]).toBe("X");
		});
	}
});
