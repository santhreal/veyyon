/**
 * Seeds 4001..4500: 50 ops each; final text is string and hash is 4 hex.
 * Why: LCG walks must leave computeFileHash valid after arbitrary legal ops.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

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

describe("applyEdits past 6000 seeds 50ops hash format 4001-4500", () => {
	for (let seed = 4001; seed <= 4500; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcg(seed);
			let t = "a\nb\nc";
			for (let i = 0; i < 50; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 6;
				if (n === 0 || op === 0) t = apply(t, `INS.HEAD:\n+H${i}`);
				else if (op === 1) t = apply(t, `INS.TAIL:\n+T${i}`);
				else if (op === 2) t = apply(t, `DEL ${(next() % n) + 1}`);
				else if (op === 3) {
					const line = (next() % n) + 1;
					t = apply(t, `SWAP ${line}.=${line}:\n+W${i}`);
				} else if (op === 4) {
					const line = (next() % n) + 1;
					t = apply(t, `INS.POST ${line}:\n+P${i}`);
				} else {
					const line = (next() % n) + 1;
					t = apply(t, `INS.PRE ${line}:\n+R${i}`);
				}
			}
			expect(typeof t).toBe("string");
			expect(computeFileHash(t)).toMatch(/^[0-9A-F]{4}$/);
		});
	}
});
