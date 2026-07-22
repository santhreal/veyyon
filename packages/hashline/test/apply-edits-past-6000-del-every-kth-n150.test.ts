/**
 * Multi-hunk DEL every k-th line for k=2..15 on n=150.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL every kth n150", () => {
	const n = 150;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 2; k <= 15; k++) {
		it(`every ${k}`, () => {
			const targets: number[] = [];
			for (let i = k; i <= n; i += k) targets.push(i);
			const patch = targets.map((t) => `DEL ${t}`).join("\n");
			expect(applyEdits(base, parsePatch(patch).edits).text.split("\n")).toEqual(
				lines.filter((_, i) => (i + 1) % k !== 0),
			);
		});
	}
});
