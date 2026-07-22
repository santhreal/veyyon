/**
 * Seeded walks for seeds 251..300: 15 ops each, no throw.
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

describe("applyEdits past 5000 seeds 251 through 300", () => {
	for (let seed = 251; seed <= 300; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcg(seed);
			let t = "u\nv";
			for (let i = 0; i < 15; i++) {
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
