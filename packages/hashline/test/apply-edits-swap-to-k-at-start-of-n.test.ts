/**
 * Expand first line of n-line file to k lines for n=3..6, k=2..4.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand first of n to k", () => {
	for (const n of [3, 4, 5, 6]) {
		for (const k of [2, 3, 4]) {
			it(`n=${n} k=${k}`, () => {
				const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
				const body = Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
				const { text: out } = applyEdits(
					base.join("\n"),
					parsePatch(`SWAP 1.=1:\n${body}`).edits,
				);
				const mid = Array.from({ length: k }, (_, i) => `E${i}`);
				expect(out).toBe([...mid, ...base.slice(1)].join("\n"));
			});
		}
	}
});
