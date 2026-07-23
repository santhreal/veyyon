/**
 * Multi-hunk DEL every k-th line for k=2..6 on n=60: exact survivors.
 * Why: stride deletes must use original indices, not cascading renumber.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL every kth n60", () => {
	const n = 60;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 2; k <= 6; k++) {
		it(`DEL every ${k}-th line`, () => {
			const targets: number[] = [];
			for (let i = k; i <= n; i += k) targets.push(i);
			const patch = targets.map(t => `DEL ${t}`).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			const expected = lines.filter((_, i) => (i + 1) % k !== 0);
			expect(text.split("\n")).toEqual(expected);
		});
	}
});
