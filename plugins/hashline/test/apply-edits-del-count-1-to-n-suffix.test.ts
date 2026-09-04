/**
 * DEL (n-k+1).=n for k=1..n on fixed n=15: remaining is exact prefix of length n-k.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL count 1 to n suffix", () => {
	const n = 15;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 1; k <= n; k++) {
		it(`DEL last ${k}`, () => {
			const start = n - k + 1;
			const patch = k === 1 ? `DEL ${n}` : `DEL ${start}.=${n}`;
			const { text } = applyEdits(base, parsePatch(patch).edits);
			if (k === n) expect(text).toBe("");
			else expect(text.split("\n")).toEqual(lines.slice(0, n - k));
		});
	}
});
