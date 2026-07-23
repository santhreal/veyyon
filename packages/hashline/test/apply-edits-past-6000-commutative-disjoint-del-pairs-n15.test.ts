/**
 * Disjoint DEL pairs multi-hunk equals sequential high-then-low on n=15.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 commutative disjoint DEL pairs n15", () => {
	const n = 15;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let b = a + 1; b <= n; b++) {
			it(`DEL ${a} and ${b}`, () => {
				const multi = applyEdits(base, parsePatch(`DEL ${a}\nDEL ${b}`).edits).text;
				const seq1 = applyEdits(base, parsePatch(`DEL ${b}`).edits).text;
				const seq = applyEdits(seq1, parsePatch(`DEL ${a}`).edits).text;
				expect(multi).toBe(seq);
				expect(multi === "" ? [] : multi.split("\n")).toEqual(lines.filter((_, i) => i + 1 !== a && i + 1 !== b));
			});
		}
	}
});
