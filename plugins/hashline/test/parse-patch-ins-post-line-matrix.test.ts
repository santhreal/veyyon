/**
 * parsePatch INS.POST/PRE for lines 1..10: exact cursor anchors.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch INS.POST line matrix", () => {
	for (let n = 1; n <= 10; n++) {
		it(`INS.POST ${n}`, () => {
			const { edits } = parsePatch(`INS.POST ${n}:\n+x`);
			expect(edits).toHaveLength(1);
			const e = edits[0];
			expect(e?.kind).toBe("insert");
			if (e?.kind === "insert") {
				expect(e.cursor.kind).toBe("after_anchor");
				if (e.cursor.kind === "after_anchor") expect(e.cursor.anchor.line).toBe(n);
				expect(e.text).toBe("x");
			}
		});
		it(`INS.PRE ${n}`, () => {
			const { edits } = parsePatch(`INS.PRE ${n}:\n+x`);
			const e = edits[0];
			expect(e?.kind).toBe("insert");
			if (e?.kind === "insert") {
				expect(e.cursor.kind).toBe("before_anchor");
				if (e.cursor.kind === "before_anchor") expect(e.cursor.anchor.line).toBe(n);
			}
		});
	}
});
