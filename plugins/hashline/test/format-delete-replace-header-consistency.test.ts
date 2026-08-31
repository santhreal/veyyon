/**
 * formatDeleteHeader is the one way to spell a delete. A bodyless
 * formatReplaceHeader (a `SWAP N.=M:` with no `+TEXT` body) is NOT a delete:
 * routing a zero-payload replace through the delete path was the Law 10
 * silent-data-loss bug, so the parser now rejects it and DEL is the explicit
 * delete form. This suite locks both halves: DEL headers parse to the exact
 * delete edits for every range, and a bodyless SWAP header throws EMPTY_REPLACE.
 */
import { describe, expect, it } from "bun:test";
import { EMPTY_REPLACE, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("formatDeleteHeader parses to delete edits; bodyless formatReplaceHeader is rejected", () => {
	for (let start = 1; start <= 4; start++) {
		for (let end = start; end <= 4; end++) {
			it(`${start}.=${end}`, () => {
				const del = parsePatch(formatDeleteHeader(start, end)).edits;
				const delLines = del.filter(e => e.kind === "delete").map(e => (e.kind === "delete" ? e.anchor.line : 0));
				expect(delLines).toEqual(Array.from({ length: end - start + 1 }, (_, i) => start + i));

				// The same range spelled as a bodyless SWAP is a parse error, never a
				// silent delete of the range.
				expect(() => parsePatch(formatReplaceHeader(start, end))).toThrow(EMPTY_REPLACE);
			});
		}
	}
});
