/**
 * Seeded deterministic walk of DEL/INS/SWAP ops: no throw, length non-negative.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

/** LCG for deterministic "random" ops. */
function lcg(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s;
	};
}

describe("applyEdits continue depth random walk seeded", () => {
	it("100 ops from seed 42 never empty-ops throw", () => {
		const next = lcg(42);
		let t = "a\nb\nc\nd\ne";
		for (let i = 0; i < 100; i++) {
			const n = t === "" ? 0 : t.split("\n").length;
			const op = next() % 4;
			if (n === 0 || op === 0) {
				t = apply(t, `INS.TAIL:\n+X${i}`);
			} else if (op === 1) {
				const line = (next() % n) + 1;
				t = apply(t, `DEL ${line}`);
			} else if (op === 2) {
				const line = (next() % n) + 1;
				t = apply(t, `SWAP ${line}.=${line}:\n+S${i}`);
			} else {
				t = apply(t, `INS.HEAD:\n+H${i}`);
			}
			if (t !== "") expect(t.split("\n").length).toBeGreaterThan(0);
		}
	});
});
