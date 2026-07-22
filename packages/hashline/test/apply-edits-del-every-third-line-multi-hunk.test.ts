/**
 * Multi-hunk DEL of every third line on n=30: exact remaining set.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL every third line multi-hunk", () => {
	it("n=30", () => {
		const n = 30;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const dels = Array.from({ length: n }, (_, i) => i + 1)
			.filter(i => i % 3 === 0)
			.map(i => `DEL ${i}`)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(dels).edits);
		const want = lines.filter((_, i) => (i + 1) % 3 !== 0);
		expect(text.split("\n")).toEqual(want);
	});
});
