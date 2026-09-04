/**
 * DEL every odd line on n=20 file leaves even lines in order.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits large n DEL every other", () => {
	it("n=20 DEL odds", () => {
		const n = 20;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const dels = Array.from({ length: n }, (_, i) => i + 1)
			.filter(i => i % 2 === 1)
			.map(i => `DEL ${i}`)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(dels).edits);
		const want = lines.filter((_, i) => (i + 1) % 2 === 0).join("\n");
		expect(text).toBe(want);
	});

	it("n=20 DEL evens", () => {
		const n = 20;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const dels = Array.from({ length: n }, (_, i) => i + 1)
			.filter(i => i % 2 === 0)
			.map(i => `DEL ${i}`)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(dels).edits);
		const want = lines.filter((_, i) => (i + 1) % 2 === 1).join("\n");
		expect(text).toBe(want);
	});
});
