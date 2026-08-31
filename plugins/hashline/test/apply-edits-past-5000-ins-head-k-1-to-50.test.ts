/**
 * INS.HEAD k rows for k=1..50 on fixed base.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 5000 INS.HEAD k 1 to 50", () => {
	for (let k = 1; k <= 50; k++) {
		it(`k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i}`).join("\n");
			const { text } = applyEdits("B", parsePatch(`INS.HEAD:\n${rows}`).edits);
			expect(text.split("\n")).toHaveLength(k + 1);
			expect(text.split("\n")[k]).toBe("B");
		});
	}
});
