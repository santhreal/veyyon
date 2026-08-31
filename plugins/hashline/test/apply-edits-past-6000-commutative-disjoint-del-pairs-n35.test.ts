/**
 * Disjoint DEL pairs multi-hunk equals sequential on n=35.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 commutative disjoint DEL pairs n35", () => {
	const n = 35;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let b = a + 1; b <= n; b++) {
			it(`DEL ${a} and ${b}`, () => {
				const multi = applyEdits(base, parsePatch(`DEL ${a}\nDEL ${b}`).edits).text;
				const seq = applyEdits(
					applyEdits(base, parsePatch(`DEL ${b}`).edits).text,
					parsePatch(`DEL ${a}`).edits,
				).text;
				expect(multi).toBe(seq);
			});
		}
	}
});
