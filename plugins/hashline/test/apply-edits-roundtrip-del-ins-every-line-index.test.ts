/**
 * For each line index: DEL it then INS.POST (or HEAD) to put it back.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits roundtrip DEL INS every line index", () => {
	const base = "a\nb\nc\nd\ne";
	const lines = base.split("\n");

	for (let i = 1; i <= 5; i++) {
		it(`remove and reinsert line ${i}`, () => {
			const removed = lines[i - 1]!;
			let t = apply(base, `DEL ${i}`);
			if (i === 1) {
				t = apply(t, `INS.HEAD:\n+${removed}`);
			} else {
				t = apply(t, `INS.POST ${i - 1}:\n+${removed}`);
			}
			expect(t).toBe(base);
		});
	}
});
