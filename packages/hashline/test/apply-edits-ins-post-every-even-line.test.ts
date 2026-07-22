/**
 * INS.POST after every even line in one patch on n=10.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST every even line", () => {
	it("n=10", () => {
		const n = 10;
		const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
		const base = lines.join("\n");
		const patch = Array.from({ length: n }, (_, i) => i + 1)
			.filter(i => i % 2 === 0)
			.map(i => `INS.POST ${i}:\n+E${i}`)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		const out = text.split("\n");
		// After each even original line, insert E{i}
		const want: string[] = [];
		for (let i = 1; i <= n; i++) {
			want.push(`L${i}`);
			if (i % 2 === 0) want.push(`E${i}`);
		}
		expect(out).toEqual(want);
	});
});
