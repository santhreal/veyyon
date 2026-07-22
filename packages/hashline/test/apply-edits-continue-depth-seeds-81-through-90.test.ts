/**
 * Seeded walks for seeds 81..90: 30 ops each, no throw.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

function lcg(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s;
	};
}

describe("applyEdits continue depth seeds 81 through 90", () => {
	for (let seed = 81; seed <= 90; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcg(seed);
			let t = "w\nx\ny\nz";
			for (let i = 0; i < 30; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 4;
				if (n === 0 || op === 0) t = apply(t, `INS.TAIL:\n+T${i}`);
				else if (op === 1) t = apply(t, `INS.HEAD:\n+H${i}`);
				else if (op === 2) t = apply(t, `DEL ${(next() % n) + 1}`);
				else {
					const line = (next() % n) + 1;
					t = apply(t, `SWAP ${line}.=${line}:\n+S${i}`);
				}
			}
			expect(typeof t).toBe("string");
		});
	}
});
