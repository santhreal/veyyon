/**
 * Stress: grow to 50 lines, delete all, rebuild to 50 via HEAD — exact end state.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits stress 50 del then rebuild", () => {
	it("tail build, full del, head rebuild", () => {
		let t = "";
		for (let i = 1; i <= 50; i++) t = apply(t, `INS.TAIL:\n+L${i}`);
		expect(t.split("\n")).toHaveLength(50);
		t = apply(t, "DEL 1.=50");
		expect(t).toBe("");
		const rows = Array.from({ length: 50 }, (_, i) => `+R${i + 1}`).join("\n");
		t = apply(t, `INS.HEAD:\n${rows}`);
		expect(t.split("\n")).toEqual(Array.from({ length: 50 }, (_, i) => `R${i + 1}`));
	});
});
