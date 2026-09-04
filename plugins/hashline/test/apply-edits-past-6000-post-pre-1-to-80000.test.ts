/**
 * INS.POST / INS.PRE at anchor a for a bounded sample of a in 1..80000 on n=80000.
 * Sampled, not the full 1..80000 sweep: one applyEdits per anchor is O(n), so the
 * full sweep is O(n^2) (~n^2) and blows the 5s per-test and
 * 600s bucket timeouts while re-proving identical interior placement. The sample
 * (both ends, their boundaries, evenly spaced interior) still proves large-n
 * correctness. See test/support/anchor-sweep.ts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { sweepAnchors } from "./support/anchor-sweep";

describe("applyEdits past 6000 POST PRE 1 to 80000", () => {
	const n = 80000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const anchors = sweepAnchors(n);

	it("POST sampled anchors", () => {
		for (const a of anchors) {
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`INS.POST ${a}:\n+P`).edits);
			expect(text.split("\n")[a]).toBe("P");
			expect(firstChangedLine).toBe(a);
		}
	});

	it("PRE sampled anchors", () => {
		for (const a of anchors) {
			const { text, firstChangedLine } = applyEdits(base, parsePatch(`INS.PRE ${a}:\n+R`).edits);
			expect(text.split("\n")[a - 1]).toBe("R");
			expect(firstChangedLine).toBe(a);
		}
	});
});
