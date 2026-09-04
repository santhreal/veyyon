/**
 * Disjoint DELs: DEL a then DEL b (adjusted) vs multi-hunk original indices
 * — multi-hunk uses original indices so order in one patch is concurrent.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits commutative disjoint DELs", () => {
	it("DEL 1 and DEL 3 in one patch equals sequential original-index thinking", () => {
		const base = "a\nb\nc\nd";
		const one = applyEdits(base, parsePatch("DEL 1\nDEL 3").edits).text;
		// concurrent: both against original → remove a and c → b\nd
		expect(one).toBe("b\nd");
	});

	it("DEL 2 and DEL 4", () => {
		const base = "a\nb\nc\nd";
		expect(applyEdits(base, parsePatch("DEL 2\nDEL 4").edits).text).toBe("a\nc");
	});

	for (const n of [5, 8]) {
		it(`n=${n} DEL all odds concurrent`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const odds = Array.from({ length: n }, (_, i) => i + 1).filter(i => i % 2 === 1);
			const patch = odds.map(i => `DEL ${i}`).join("\n");
			const { text } = applyEdits(base, parsePatch(patch).edits);
			const want = lines.filter((_, i) => (i + 1) % 2 === 0);
			expect(text.split("\n")).toEqual(want);
		});
	}
});
