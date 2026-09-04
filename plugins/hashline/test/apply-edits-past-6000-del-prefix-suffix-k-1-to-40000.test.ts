/**
 * DEL prefix (1.=k) and suffix ((n-k+1).=n) for a bounded sample of k in 1..40000
 * on n=40000. Sampled, not the full 1..40000 sweep: one applyEdits per k is O(n), so
 * the full sweep is O(n^2) and blows the 5s per-test and 600s bucket timeouts
 * while re-proving identical length arithmetic. The sample still proves large-n
 * correctness. See test/support/anchor-sweep.ts.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { sweepAnchors } from "./support/anchor-sweep";

describe("applyEdits past 6000 DEL prefix suffix k 1 to 40000", () => {
	const n = 40000;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const anchors = sweepAnchors(n);

	it("DEL prefix sampled k", () => {
		for (const k of anchors) {
			const { text } = applyEdits(base, parsePatch(`DEL 1.=${k}`).edits);
			expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
		}
	});

	it("DEL suffix sampled k", () => {
		for (const k of anchors) {
			const start = n - k + 1;
			const { text } = applyEdits(base, parsePatch(`DEL ${start}.=${n}`).edits);
			expect(text === "" ? [] : text.split("\n")).toHaveLength(n - k);
		}
	});
});
