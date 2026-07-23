/**
 * Shrink last k lines of n-line file to single X.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits shrink last k of n", () => {
	for (const n of [4, 6, 8]) {
		for (const k of [2, 3, 4]) {
			if (k > n) continue;
			it(`n=${n} k=${k}`, () => {
				const base = Array.from({ length: n }, (_, i) => `L${i + 1}`);
				const start = n - k + 1;
				const { text: out } = applyEdits(base.join("\n"), parsePatch(`SWAP ${start}.=${n}:\n+X`).edits);
				expect(out).toBe([...base.slice(0, start - 1), "X"].join("\n"));
			});
		}
	}
});
