/**
 * Multi-hunk DEL of every even line on n=40 in one patch: exact odds remain.
 * Why: concurrent original-index multi-DEL must not cascade renumber mid-patch.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 multi-hunk DEL evens n40", () => {
	const n = 40;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const delHeaders = Array.from({ length: n / 2 }, (_, i) => {
		const line = (i + 1) * 2;
		return `DEL ${line}`;
	}).join("\n");

	it("one patch deletes all evens, odds remain in order", () => {
		const { text } = applyEdits(base, parsePatch(delHeaders).edits);
		const out = text.split("\n");
		const odds = lines.filter((_, i) => (i + 1) % 2 === 1);
		expect(out).toEqual(odds);
		expect(out).toHaveLength(n / 2);
	});

	it("odds multi-hunk DEL leaves evens", () => {
		const oddHeaders = Array.from({ length: n / 2 }, (_, i) => `DEL ${i * 2 + 1}`).join("\n");
		const { text } = applyEdits(base, parsePatch(oddHeaders).edits);
		expect(text.split("\n")).toEqual(lines.filter((_, i) => (i + 1) % 2 === 0));
	});
});
