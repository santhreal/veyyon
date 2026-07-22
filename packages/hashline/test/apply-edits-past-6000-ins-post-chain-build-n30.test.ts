/**
 * Sequential INS.POST after last line builds a list of length base+k for k=1..30.
 * Why: chain-build after moving anchor must not re-bind to stale line numbers.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS POST chain build n30", () => {
	it("POST after last repeatedly grows file", () => {
		let t = "ROOT";
		for (let i = 1; i <= 30; i++) {
			const n = t.split("\n").length;
			t = applyEdits(t, parsePatch(`INS.POST ${n}:\n+C${i}`).edits).text;
			const out = t.split("\n");
			expect(out).toHaveLength(i + 1);
			expect(out[0]).toBe("ROOT");
			expect(out[i]).toBe(`C${i}`);
		}
		expect(t.split("\n")).toEqual([
			"ROOT",
			...Array.from({ length: 30 }, (_, i) => `C${i + 1}`),
		]);
	});

	it("PRE before first repeatedly grows prefix", () => {
		let t = "ROOT";
		for (let i = 1; i <= 20; i++) {
			t = applyEdits(t, parsePatch(`INS.PRE 1:\n+P${i}`).edits).text;
			expect(t.split("\n")[0]).toBe(`P${i}`);
		}
		const out = t.split("\n");
		expect(out).toHaveLength(21);
		expect(out[20]).toBe("ROOT");
		// most recent PRE is first
		expect(out[0]).toBe("P20");
	});
});
