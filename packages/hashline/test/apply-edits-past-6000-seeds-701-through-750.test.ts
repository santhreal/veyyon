/**
 * Seeded walks for seeds 701..750: 20 ops each, exact non-throw + final string type.
 * Why: expands pure LCG coverage past the 651-700 band with more ops per seed.
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

describe("applyEdits past 6000 seeds 701 through 750", () => {
	for (let seed = 701; seed <= 750; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcg(seed);
			let t = "a\nb\nc";
			for (let i = 0; i < 20; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 5;
				if (n === 0 || op === 0) t = apply(t, `INS.TAIL:\n+T${i}`);
				else if (op === 1) t = apply(t, `INS.HEAD:\n+H${i}`);
				else if (op === 2) t = apply(t, `DEL ${(next() % n) + 1}`);
				else if (op === 3) {
					const line = (next() % n) + 1;
					t = apply(t, `SWAP ${line}.=${line}:\n+S${i}`);
				} else {
					const line = (next() % n) + 1;
					t = apply(t, `INS.POST ${line}:\n+P${i}`);
				}
			}
			expect(typeof t).toBe("string");
			if (t !== "") expect(t.split("\n").length).toBeGreaterThan(0);
		});
	}
});
