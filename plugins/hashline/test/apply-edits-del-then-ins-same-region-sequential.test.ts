/**
 * Sequential DEL then INS rebuild of a region yields exact final content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits DEL then INS same region sequential", () => {
	for (const n of [3, 5, 8]) {
		it(`replace middle third of n=${n} via del+ins`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			let t = lines.join("\n");
			const mid = Math.floor(n / 2) + 1;
			t = apply(t, `DEL ${mid}`);
			// after del, insert at mid-1 POST or PRE mid
			if (mid === 1) {
				t = apply(t, "INS.HEAD:\n+MID");
			} else {
				t = apply(t, `INS.POST ${mid - 1}:\n+MID`);
			}
			const out = t.split("\n");
			expect(out).toContain("MID");
			expect(out).not.toContain(`L${mid}`);
			expect(out.length).toBe(n);
		});
	}

	it("clear file then rebuild with HEAD", () => {
		let t = "a\nb\nc";
		t = apply(t, "DEL 1.=3");
		expect(t).toBe("");
		t = apply(t, "INS.HEAD:\n+x\n+y");
		expect(t).toBe("x\ny");
	});
});
