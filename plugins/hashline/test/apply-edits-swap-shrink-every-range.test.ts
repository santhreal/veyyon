/**
 * Shrink every multi-line range of 5-line file to single token.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits shrink multi-line ranges of 5", () => {
	const base = ["1", "2", "3", "4", "5"];
	const text = base.join("\n");
	for (let start = 1; start <= 4; start++) {
		for (let end = start + 1; end <= 5; end++) {
			it(`SWAP ${start}.=${end} -> X`, () => {
				const { text: out } = applyEdits(text, parsePatch(`SWAP ${start}.=${end}:\n+X`).edits);
				const want = [...base];
				want.splice(start - 1, end - start + 1, "X");
				expect(out).toBe(want.join("\n"));
			});
		}
	}
});
