/**
 * Seeded deterministic walk of DEL/INS/SWAP ops: no throw, length non-negative.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";
import { lcgUint32 } from "@veyyon/utils/adversarial-strings";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

/** LCG for deterministic "random" ops. */
describe("applyEdits continue depth random walk seeded", () => {
	// Each op has a known effect on line count. Walking 100 of them and checking
	// the count after every step catches an applier that drops or duplicates a
	// line only after a specific op sequence.
	it("100 ops from seed 42 keep the line count exact", () => {
		const next = lcgUint32(42);
		let t = "a\nb\nc\nd\ne";
		let expected = 5;
		for (let i = 0; i < 100; i++) {
			const n = t === "" ? 0 : t.split("\n").length;
			const op = next() % 4;
			if (n === 0 || op === 0) {
				t = apply(t, `INS.TAIL:\n+X${i}`);
				expected += 1;
				expect(t.split("\n").at(-1)).toBe(`X${i}`);
			} else if (op === 1) {
				const line = (next() % n) + 1;
				const dropped = t.split("\n")[line - 1];
				t = apply(t, `DEL ${line}`);
				expected -= 1;
				expect(t.split("\n")[line - 1]).not.toBe(dropped);
			} else if (op === 2) {
				const line = (next() % n) + 1;
				t = apply(t, `SWAP ${line}.=${line}:\n+S${i}`);
				expect(t.split("\n")[line - 1]).toBe(`S${i}`);
			} else {
				t = apply(t, `INS.HEAD:\n+H${i}`);
				expected += 1;
				expect(t.split("\n")[0]).toBe(`H${i}`);
			}
			expect(t.split("\n").length).toBe(expected);
		}
	});
});
