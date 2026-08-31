/**
 * INS.TAIL k rows for k=1..25 on fixed base: length = 1+k.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits continue depth INS.TAIL k 1 to 25", () => {
	for (let k = 1; k <= 25; k++) {
		it(`k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+T${i}`).join("\n");
			const { text } = applyEdits("B", parsePatch(`INS.TAIL:\n${rows}`).edits);
			expect(text.split("\n")).toHaveLength(k + 1);
			expect(text.split("\n")[0]).toBe("B");
		});
	}
});
