/**
 * DEL single line i for i=1..25000 on n=25000.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { sweepAnchors } from "./support/anchor-sweep";

describe("applyEdits past 6000 DEL line 1 to 25000", () => {
	const n = 25000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (const i of sweepAnchors(n)) {
		it(`DEL ${i}`, () => {
			const { firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			expect(firstChangedLine).toBe(i);
		});
	}
});
