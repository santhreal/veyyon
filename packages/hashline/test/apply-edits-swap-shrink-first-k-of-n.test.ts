/**
 * Shrink first k lines of n-line file to single X.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits shrink first k of n", () => {
	for (const n of [4, 6, 8]) {
		for (const k of [2, 3, 4]) {
			if (k > n) continue;
			it(`n=${n} k=${k}`, () => {
				const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
				const { text: out } = applyEdits(
					base.join("\n"),
					parsePatch(`SWAP 1.=${k}:\n+X`).edits,
				);
				expect(out).toBe(["X", ...base.slice(k)].join("\n"));
			});
		}
	}
});
