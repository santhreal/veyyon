/**
 * parsePatch always returns a warnings array (never undefined).
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch warnings array contract", () => {
	const diffs = [
		"DEL 1",
		"SWAP 1.=1:\n+x",
		"INS.HEAD:\n+h",
		"INS.TAIL:\n+t",
		"INS.POST 1:\n+x",
		"REM",
		"MV dest.ts",
		"SWAP.BLK 1:\n+x",
		"DEL 1.=3",
		"INS.PRE 2:\n+a\n+b",
	];
	for (const diff of diffs) {
		it(`warnings is array for ${JSON.stringify(diff).slice(0, 30)}`, () => {
			const r = parsePatch(diff);
			expect(Array.isArray(r.warnings)).toBe(true);
			expect(Array.isArray(r.edits)).toBe(true);
		});
	}
});
