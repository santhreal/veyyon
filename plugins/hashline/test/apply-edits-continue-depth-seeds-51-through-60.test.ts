/**
 * Seeded walks for seeds 51..60: 40 ops each, no throw.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { lcgUint32 } from "@veyyon/utils/adversarial-strings";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits continue depth seeds 51 through 60", () => {
	for (let seed = 51; seed <= 60; seed++) {
		it(`seed=${seed}`, () => {
			const next = lcgUint32(seed);
			let t = "a\nb\nc";
			for (let i = 0; i < 40; i++) {
				const n = t === "" ? 0 : t.split("\n").length;
				const op = next() % 3;
				if (n === 0 || op === 0) t = apply(t, `INS.HEAD:\n+${seed}_${i}`);
				else if (op === 1) t = apply(t, `DEL ${(next() % n) + 1}`);
				else {
					const line = (next() % n) + 1;
					t = apply(t, `SWAP ${line}.=${line}:\n+S`);
				}
			}
			expect(typeof t).toBe("string");
		});
	}
});
