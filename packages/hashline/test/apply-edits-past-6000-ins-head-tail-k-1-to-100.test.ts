/**
 * INS.HEAD / INS.TAIL k rows for k=1..100 on fixed 1-line base.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS HEAD/TAIL k 1 to 100", () => {
	const base = "Z";

	for (let k = 1; k <= 100; k++) {
		it(`HEAD k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+H${i + 1}`).join("\n");
			const { text } = applyEdits(base, parsePatch(`INS.HEAD:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out).toHaveLength(k + 1);
			expect(out[k]).toBe("Z");
			expect(out.slice(0, k)).toEqual(Array.from({ length: k }, (_, i) => `H${i + 1}`));
		});

		it(`TAIL k=${k}`, () => {
			const rows = Array.from({ length: k }, (_, i) => `+T${i + 1}`).join("\n");
			const { text } = applyEdits(base, parsePatch(`INS.TAIL:\n${rows}`).edits);
			const out = text.split("\n");
			expect(out[0]).toBe("Z");
			expect(out.slice(1)).toEqual(Array.from({ length: k }, (_, i) => `T${i + 1}`));
		});
	}
});
