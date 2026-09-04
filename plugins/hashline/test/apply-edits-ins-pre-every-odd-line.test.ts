/**
 * INS.PRE before every odd line in one patch on n=10.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE every odd line", () => {
	it("n=10", () => {
		const n = 10;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const patch = Array.from({ length: n }, (_, i) => i + 1)
			.filter(i => i % 2 === 1)
			.map(i => `INS.PRE ${i}:\n+O${i}`)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		const want: string[] = [];
		for (let i = 1; i <= n; i++) {
			if (i % 2 === 1) want.push(`O${i}`);
			want.push(`L${i}`);
		}
		expect(text.split("\n")).toEqual(want);
	});
});
