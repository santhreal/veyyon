/**
 * Multi-hunk DEL every k-th line on n=250.
 * Why: concurrent original indices for sparse deletes must keep survivors exact.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL every kth n250", () => {
	const n = 250;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (const k of [2, 3, 4, 5, 7, 10]) {
		it(`every ${k}th`, () => {
			const targets: number[] = [];
			for (let i = k; i <= n; i += k) targets.push(i);
			const hunks = targets.map((t) => `DEL ${t}`).join("\n");
			const out = applyEdits(base, parsePatch(hunks).edits).text;
			const expected = lines.filter((_, i) => (i + 1) % k !== 0);
			expect(out === "" ? [] : out.split("\n")).toEqual(expected);
		});
	}
});
