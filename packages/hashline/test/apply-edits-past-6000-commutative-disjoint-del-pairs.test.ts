/**
 * Disjoint single-line DEL pairs: multi-hunk one-shot equals sequential (high then low).
 * Why: concurrent original indices must commute for non-overlapping deletes.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 commutative disjoint DEL pairs", () => {
	const n = 20;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let b = a + 1; b <= n; b++) {
			it(`DEL ${a} and ${b}`, () => {
				const multi = applyEdits(base, parsePatch(`DEL ${a}\nDEL ${b}`).edits).text;
				// sequential: delete higher index first so lower stays stable
				const seq1 = applyEdits(base, parsePatch(`DEL ${b}`).edits).text;
				const seq = applyEdits(seq1, parsePatch(`DEL ${a}`).edits).text;
				expect(multi).toBe(seq);
				const expected = lines.filter((_, i) => i + 1 !== a && i + 1 !== b);
				expect(multi === "" ? [] : multi.split("\n")).toEqual(expected);
			});
		}
	}
});
