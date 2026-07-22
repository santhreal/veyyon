/**
 * INS.HEAD / INS.TAIL k rows for k=1..12000.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS HEAD/TAIL k 1 to 12000", () => {
	const base = "Z";

	for (let k = 1; k <= 12000; k++) {
		it(`HEAD k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i + 1}`).join("\n");
			const out = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits).text.split("\n");
			expect(out).toHaveLength(k + 1);
			expect(out[k]).toBe("Z");
		});

		it(`TAIL k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+T${i + 1}`).join("\n");
			const out = applyEdits(base, parsePatch(`INS.TAIL:\n${rows}`).edits).text.split("\n");
			expect(out[0]).toBe("Z");
			expect(out).toHaveLength(k + 1);
		});
	}
});
