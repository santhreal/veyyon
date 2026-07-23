/**
 * A bodyless SWAP over every range of a 5-line file is rejected; the matching
 * DEL removes that range. Exhaustive range coverage of the strict contract: the
 * parser throws EMPTY_REPLACE for `SWAP start.=end:` with no body, and `DEL
 * start.=end` produces the exact remaining text.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("bodyless SWAP over all ranges is rejected; DEL removes them (n=5)", () => {
	const lines = ["1", "2", "3", "4", "5"];
	const text = lines.join("\n");
	for (let start = 1; start <= 5; start++) {
		for (let end = start; end <= 5; end++) {
			it(`${start}.=${end}`, () => {
				expect(() => parsePatch(formatReplaceHeader(start, end))).toThrow(EMPTY_REPLACE);
				const viaDel = applyEdits(text, parsePatch(formatDeleteHeader(start, end)).edits).text;
				const want = lines.filter((_, j) => j + 1 < start || j + 1 > end).join("\n");
				expect(viaDel).toBe(want);
			});
		}
	}
});
