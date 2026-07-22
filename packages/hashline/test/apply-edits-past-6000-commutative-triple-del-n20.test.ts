/**
 * Triple disjoint DEL multi-hunk equals sequential high-to-low on n=20.
 * Why: three concurrent original deletes must match sequential application.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 commutative triple DEL n20", () => {
	const n = 20;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let b = a + 1; b <= n; b++) {
			for (let c = b + 1; c <= n; c++) {
				it(`DEL ${a},${b},${c}`, () => {
					const multi = applyEdits(
						base,
						parsePatch(`DEL ${a}\nDEL ${b}\nDEL ${c}`).edits,
					).text;
					const seq = applyEdits(
						applyEdits(
							applyEdits(base, parsePatch(`DEL ${c}`).edits).text,
							parsePatch(`DEL ${b}`).edits,
						).text,
						parsePatch(`DEL ${a}`).edits,
					).text;
					expect(multi).toBe(seq);
					const expected = lines.filter((_, i) => {
						const L = i + 1;
						return L !== a && L !== b && L !== c;
					});
					expect(multi === "" ? [] : multi.split("\n")).toEqual(expected);
				});
			}
		}
	}
});
