/**
 * REM and MV alone: empty edits, exact fileOp.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch REM and MV alone", () => {
	it("REM", () => {
		const r = parsePatch("REM");
		expect(r.edits).toEqual([]);
		expect(r.fileOp).toEqual({ kind: "rem" });
		expect(r.warnings).toEqual([]);
	});

	const dests = ["a.ts", "b/c.ts", "x-y.ts", "z_w.ts"];
	for (const d of dests) {
		it(`MV ${d}`, () => {
			const r = parsePatch(`MV ${d}`);
			expect(r.edits).toEqual([]);
			expect(r.fileOp).toEqual({ kind: "move", dest: d });
		});
	}
});
