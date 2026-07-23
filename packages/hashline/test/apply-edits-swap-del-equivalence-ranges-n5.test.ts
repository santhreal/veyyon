/**
 * Bodyless SWAP equals DEL for all ranges of 5-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("bodyless SWAP equals DEL all ranges n=5", () => {
	const text = "1\n2\n3\n4\n5";
	for (let start = 1; start <= 5; start++) {
		for (let end = start; end <= 5; end++) {
			it(`${start}.=${end}`, () => {
				const viaSwap = applyEdits(text, parsePatch(formatReplaceHeader(start, end)).edits).text;
				const viaDel = applyEdits(text, parsePatch(formatDeleteHeader(start, end)).edits).text;
				expect(viaSwap).toBe(viaDel);
			});
		}
	}
});
