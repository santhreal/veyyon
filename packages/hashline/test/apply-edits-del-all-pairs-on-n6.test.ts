/**
 * DEL every adjacent pair range on 6-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL adjacent pairs n=6", () => {
	const base = ["1", "2", "3", "4", "5", "6"];
	const text = base.join("\n");
	for (let start = 1; start <= 5; start++) {
		const end = start + 1;
		it(`DEL ${start}.=${end}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`DEL ${start}.=${end}`).edits);
			const want = base.filter((_, i) => i + 1 < start || i + 1 > end).join("\n");
			expect(out).toBe(want);
		});
	}
});
