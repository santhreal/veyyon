/**
 * hasAnchorScopedEdit / hasBlockEdit classification matrix.
 */
import { describe, expect, it } from "bun:test";
import { hasAnchorScopedEdit, hasBlockEdit, parsePatch } from "@veyyon/hashline";

describe("hasBlockEdit / hasAnchorScopedEdit matrix", () => {
	const cases: Array<{
		diff: string;
		block: boolean;
		anchor: boolean;
	}> = [
		{ diff: "SWAP 1.=1:\n+x", block: false, anchor: true },
		{ diff: "DEL 1", block: false, anchor: true },
		{ diff: "INS.POST 1:\n+x", block: false, anchor: true },
		{ diff: "INS.PRE 1:\n+x", block: false, anchor: true },
		{ diff: "INS.HEAD:\n+x", block: false, anchor: false },
		{ diff: "INS.TAIL:\n+x", block: false, anchor: false },
		{ diff: "SWAP.BLK 1:\n+x", block: true, anchor: true },
		{ diff: "DEL.BLK 1", block: true, anchor: true },
		{ diff: "INS.BLK.POST 1:\n+x", block: true, anchor: true },
		{ diff: "REM", block: false, anchor: false },
		{ diff: "MV dest.ts", block: false, anchor: false },
	];

	for (const c of cases) {
		it(`${JSON.stringify(c.diff).slice(0, 40)} block=${c.block} anchor=${c.anchor}`, () => {
			const edits = parsePatch(c.diff).edits;
			expect(hasBlockEdit(edits)).toBe(c.block);
			expect(hasAnchorScopedEdit(edits)).toBe(c.anchor);
		});
	}
});
