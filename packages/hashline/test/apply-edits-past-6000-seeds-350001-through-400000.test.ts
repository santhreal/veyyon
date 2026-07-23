/**
 * Seeded walks for seeds 350001..400000: 50 ops each (50000 seeds). Crosses 400000 seed band.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { seedBand } from "./support/seed-band";

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

describe("applyEdits past 6000 seeds 350001 through 400000", () => {
	for (const seed of seedBand(350001, 400000)) {
		it(`seed=${seed}`, () => {
			const next = lcg(seed);
			let t = "x\ny";
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
		});
	}
});
