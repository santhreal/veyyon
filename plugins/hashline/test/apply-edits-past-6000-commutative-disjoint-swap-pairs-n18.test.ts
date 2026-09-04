/**
 * Disjoint SWAP pairs on n=18 concurrent multi-hunk.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 commutative disjoint SWAP pairs n18", () => {
	const n = 18;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let b = a + 1; b <= n; b++) {
			it(`SWAP ${a} and ${b}`, () => {
				const out = applyEdits(base, parsePatch(`SWAP ${a}.=${a}:\n+A\nSWAP ${b}.=${b}:\n+B`).edits).text.split(
					"\n",
				);
				expect(out[a - 1]).toBe("A");
				expect(out[b - 1]).toBe("B");
			});
		}
	}
});
