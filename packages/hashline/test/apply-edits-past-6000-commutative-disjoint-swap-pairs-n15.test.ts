/**
 * Disjoint SWAP pairs on n=15: multi-hunk concurrent exact bodies.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 commutative disjoint SWAP pairs n15", () => {
	const n = 15;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let a = 1; a <= n; a++) {
		for (let b = a + 1; b <= n; b++) {
			it(`SWAP ${a} and ${b}`, () => {
				const { text } = applyEdits(
					base,
					parsePatch(`SWAP ${a}.=${a}:\n+A\nSWAP ${b}.=${b}:\n+B`).edits,
				);
				const out = text.split("\n");
				expect(out[a - 1]).toBe("A");
				expect(out[b - 1]).toBe("B");
				for (let i = 0; i < n; i++) {
					if (i !== a - 1 && i !== b - 1) expect(out[i]).toBe(`L${i + 1}`);
				}
			});
		}
	}
});
