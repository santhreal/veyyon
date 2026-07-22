/**
 * Multi-hunk DEL every k-th line for k=2..10 on n=100.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 DEL every kth n100", () => {
	const n = 100;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	for (let k = 2; k <= 10; k++) {
		it(`every ${k}`, () => {
			const targets: number[] = [];
			for (let i = k; i <= n; i += k) targets.push(i);
			const patch = targets.map((t) => `DEL ${t}`).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			expect(text.split("\n")).toEqual(lines.filter((_, i) => (i + 1) % k !== 0));
		});
	}
});
