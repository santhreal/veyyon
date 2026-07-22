/**
 * DEL every range of 6-line file with length 1..3.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL ranges length 1..3 of n=6", () => {
	const base = ["1", "2", "3", "4", "5", "6"];
	const text = base.join("\n");
	for (let start = 1; start <= 6; start++) {
		for (let len = 1; len <= 3; len++) {
			const end = start + len - 1;
			if (end > 6) continue;
			it(`DEL ${start}.=${end}`, () => {
				const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
				const { text: out } = applyEdits(text, parsePatch(header).edits);
				const want = base.filter((_, i) => i + 1 < start || i + 1 > end).join("\n");
				expect(out).toBe(want);
			});
		}
	}
});
