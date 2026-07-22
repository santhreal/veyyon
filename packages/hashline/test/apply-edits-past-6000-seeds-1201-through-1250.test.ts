/**
 * Seeded walks for seeds 1201..1250: 40 ops each.
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

describe("applyEdits past 6000 seeds 1201 through 1250", () => {
	for (let seed = 1201; seed <= 1250; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcg(seed);
			let t = "p\nq\nr";
			for (let i = 0; i < 40; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 6;
				if (n === 0 || op === 0) t = apply(t, `INS.TAIL:\n+T${i}`);
				else if (op === 1) t = apply(t, `INS.HEAD:\n+H${i}`);
				else if (op === 2) t = apply(t, `DEL ${(next() % n) + 1}`);
				else if (op === 3) {
					const line = (next() % n) + 1;
					t = apply(t, `SWAP ${line}.=${line}:\n+S${i}`);
				} else if (op === 4) {
					const line = (next() % n) + 1;
					t = apply(t, `INS.POST ${line}:\n+P${i}`);
				} else {
					const line = (next() % n) + 1;
					t = apply(t, `INS.PRE ${line}:\n+R${i}`);
				}
			}
			expect(typeof t).toBe("string");
		});
	}
});
