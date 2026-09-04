/**
 * SWAP every contiguous subrange of a 5-line file to a single token R.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP every subrange of 5 lines to R", () => {
	const base = ["1", "2", "3", "4", "5"];
	const text = base.join("\n");
	for (let start = 1; start <= 5; start++) {
		for (let end = start; end <= 5; end++) {
			it(`SWAP ${start}.=${end}`, () => {
				const h = formatReplaceHeader(start, end);
				const { text: out } = applyEdits(text, parsePatch(`${h}\n+R`).edits);
				const want = [...base];
				want.splice(start - 1, end - start + 1, "R");
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
