/**
 * Past 4500: continue pure depth with exact multi-op chains.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits past 4500 continue depth", () => {
	it("build 5 via tail, reverse via head rebuild", () => {
		let t = "";
		for (let i = 1; i <= 5; i++) t = apply(t, `INS.TAIL:\n+${i}`);
		expect(t).toBe("1\n2\n3\n4\n5");
		t = apply(t, "DEL 1.=5");
		const rows = Array.from({ length: 5 }, (_, i) => `+${5 - i}`).join("\n");
		t = apply(t, `INS.HEAD:\n${rows}`);
		expect(t).toBe("5\n4\n3\n2\n1");
	});

	for (const n of [3, 6, 9]) {
		it(`mirror swap n=${n}`, () => {
			const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
			const base = lines.join("\n");
			const mid = Math.ceil(n / 2);
			const { text } = applyEdits(base, parsePatch(`SWAP ${mid}.=${mid}:\n+MID`).edits);
			expect(text.split("\n")[mid - 1]).toBe("MID");
		});
	}
});
