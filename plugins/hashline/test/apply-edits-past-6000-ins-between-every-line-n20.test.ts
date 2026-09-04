/**
 * Multi-hunk INS.POST after every line on n=20 in one patch: interleave markers.
 * Why: concurrent original-index POSTs must insert between each original pair.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS between every line n20", () => {
	const n = 20;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("POST after each line in one multi-hunk patch", () => {
		const hunks = Array.from({ length: n }, (_, i) => `INS.POST ${i + 1}:\n+M${i + 1}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		const out = text.split("\n");
		expect(out).toHaveLength(n * 2);
		for (let i = 0; i < n; i++) {
			expect(out[i * 2]).toBe(`L${i + 1}`);
			expect(out[i * 2 + 1]).toBe(`M${i + 1}`);
		}
	});

	it("PRE before each line in one multi-hunk patch", () => {
		const hunks = Array.from({ length: n }, (_, i) => `INS.PRE ${i + 1}:\n+M${i + 1}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		const out = text.split("\n");
		expect(out).toHaveLength(n * 2);
		for (let i = 0; i < n; i++) {
			expect(out[i * 2]).toBe(`M${i + 1}`);
			expect(out[i * 2 + 1]).toBe(`L${i + 1}`);
		}
	});
});
