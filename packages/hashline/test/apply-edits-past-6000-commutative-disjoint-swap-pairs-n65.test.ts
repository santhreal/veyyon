/**
 * Disjoint SWAP pairs multi-hunk equals sequential on n=65.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 commutative disjoint SWAP pairs n65", () => {
	const n = 65;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let b = a + 1; b <= n; b++) {
			it(`SWAP ${a} and ${b}`, () => {
				const multi = applyEdits(
					base,
					parsePatch(`SWAP ${a}.=${a}:\n+A${a}\nSWAP ${b}.=${b}:\n+B${b}`).edits,
				).text;
				const seq = applyEdits(
					applyEdits(base, parsePatch(`SWAP ${b}.=${b}:\n+B${b}`).edits).text,
					parsePatch(`SWAP ${a}.=${a}:\n+A${a}`).edits,
				).text;
				expect(multi).toBe(seq);
			});
		}
	}
});
