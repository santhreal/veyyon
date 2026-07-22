/**
 * formatDeleteHeader / formatReplaceHeader parse consistently for same ranges.
 */
import { describe, expect, it } from "bun:test";
import {
	formatDeleteHeader,
	formatReplaceHeader,
	parsePatch,
} from "@veyyon/hashline";

describe("formatDelete vs bodyless formatReplace parse delete lines", () => {
	for (let start = 1; start <= 4; start++) {
		for (let end = start; end <= 4; end++) {
			it(`${start}.=${end}`, () => {
				const del = parsePatch(formatDeleteHeader(start, end)).edits;
				const swap = parsePatch(formatReplaceHeader(start, end)).edits;
				const delLines = del
					.filter(e => e.kind === "delete")
					.map(e => (e.kind === "delete" ? e.anchor.line : 0));
				const swapLines = swap
					.filter(e => e.kind === "delete")
					.map(e => (e.kind === "delete" ? e.anchor.line : 0));
				expect(swapLines).toEqual(delLines);
				expect(delLines).toEqual(
					Array.from({ length: end - start + 1 }, (_, i) => start + i),
				);
			});
		}
	}
});
