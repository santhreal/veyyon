/**
 * Seeds 5001..5500: 40 ops; line count stays within [0, 3+40*2] bound.
 * Why: each op inserts at most a few lines; unbounded growth would signal a bug.
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

describe("applyEdits past 6000 seeds ops linecount bounds 5001-5500", () => {
	const ops = 40;
	const maxLines = 3 + ops * 2; // each insert at most 1 line in this walk
	for (const seed of seedBand(5001, 5500)) {
		it(`seed=${seed}`, () => {
			const next = lcg(seed);
			let t = "a\nb\nc";
			for (let i = 0; i < ops; i++) {
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
			const lines = t === "" ? 0 : t.split("\n").length;
			expect(lines).toBeGreaterThanOrEqual(0);
			expect(lines).toBeLessThanOrEqual(maxLines);
		});
	}
});
