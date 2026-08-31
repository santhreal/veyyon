/**
 * formatReplaceHeader for ranges 1..4, round-trip parse + apply exact body.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("formatReplaceHeader round-trip matrix", () => {
	const base = ["w", "x", "y", "z"];
	const text = base.join("\n");

	for (let start = 1; start <= 4; start++) {
		for (let end = start; end <= 4; end++) {
			it(`SWAP ${start}.=${end} -> R`, () => {
				const h = formatReplaceHeader(start, end);
				expect(h).toBe(`SWAP ${start}.=${end}:`);
				const { text: out } = applyEdits(text, parsePatch(`${h}\n+R`).edits);
				const want = [...base];
				want.splice(start - 1, end - start + 1, "R");
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
