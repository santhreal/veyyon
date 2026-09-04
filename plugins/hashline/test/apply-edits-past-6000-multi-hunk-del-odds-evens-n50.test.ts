/**
 * Multi-hunk DEL odds and DEL evens on n=50: each leaves the complementary set.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 multi-hunk DEL odds evens n50", () => {
	const n = 50;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("DEL all odds", () => {
		const patch = Array.from({ length: n / 2 }, (_, i) => `DEL ${i * 2 + 1}`).join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		expect(text.split("\n")).toEqual(lines.filter((_, i) => (i + 1) % 2 === 0));
	});

	it("DEL all evens", () => {
		const patch = Array.from({ length: n / 2 }, (_, i) => `DEL ${(i + 1) * 2}`).join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		expect(text.split("\n")).toEqual(lines.filter((_, i) => (i + 1) % 2 === 1));
	});

	it("DEL odds then DEL remaining leaves empty", () => {
		const odds = Array.from({ length: n / 2 }, (_, i) => `DEL ${i * 2 + 1}`).join("\n");
		const mid = applyEdits(base, parsePatch(odds).edits).text;
		// remaining is n/2 lines (former evens), now renumbered 1..n/2
		const rest = applyEdits(mid, parsePatch(`DEL 1.=${n / 2}`).edits).text;
		expect(rest).toBe("");
	});
});
