/**
 * DEL each single line of 6-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL each of 6", () => {
	const base = ["1", "2", "3", "4", "5", "6"];
	const text = base.join("\n");
	for (let i = 1; i <= 6; i++) {
		it(`DEL ${i}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`DEL ${i}`).edits);
			const want = base.filter((_, j) => j + 1 !== i).join("\n");
			expect(out).toBe(want);
		});
	}
});
