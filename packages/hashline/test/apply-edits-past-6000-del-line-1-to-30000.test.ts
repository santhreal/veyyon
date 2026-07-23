/**
 * DEL single line i for i=1..30000 on n=30000.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { sweepAnchors } from "./support/anchor-sweep";

describe("applyEdits past 6000 DEL line 1 to 30000", () => {
	const n = 30000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (const i of sweepAnchors(n)) {
		it(`DEL ${i}`, () => {
			const { firstChangedLine } = applyEdits(base, parsePatch(`DEL ${i}`).edits);
			expect(firstChangedLine).toBe(i);
		});
	}
});
