/**
 * A bodyless SWAP is REJECTED, never silently treated as a delete.
 *
 * The parser refuses `SWAP N.=M:` with no `+TEXT` body (parser.ts): the body is
 * the final content, so its absence usually means a truncated stream, and
 * silently deleting the range would be silent data loss (the exact footgun the
 * CHANGELOG's "ambiguous swaps could silently delete range boundaries" fix
 * removed). Deleting is spelled `DEL`. This suite pins both halves across every
 * line and short range of an N-line file: the SWAP-to-empty throws EMPTY_REPLACE
 * pointing at DEL, and the matching DEL produces the exact remaining text.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, formatDeleteHeader, formatReplaceHeader, parsePatch } from "@veyyon/hashline";

describe("bodyless SWAP is rejected; DEL deletes (n=6)", () => {
	const n = 6;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const text = lines.join("\n");
	const remainingAfterDelete = (start: number, end: number) =>
		lines.filter((_, j) => j + 1 < start || j + 1 > end).join("\n");

	for (let i = 1; i <= n; i++) {
		it(`line ${i}: SWAP to empty throws EMPTY_REPLACE, DEL removes the line`, () => {
			expect(() => parsePatch(formatReplaceHeader(i, i))).toThrow(EMPTY_REPLACE);
			const viaDel = applyEdits(text, parsePatch(formatDeleteHeader(i)).edits).text;
			expect(viaDel).toBe(remainingAfterDelete(i, i));
		});
	}

	for (let start = 1; start <= n; start++) {
		for (let end = start; end <= Math.min(start + 2, n); end++) {
			it(`range ${start}.=${end}: SWAP to empty throws EMPTY_REPLACE, DEL removes the range`, () => {
				expect(() => parsePatch(formatReplaceHeader(start, end))).toThrow(EMPTY_REPLACE);
				const viaDel = applyEdits(text, parsePatch(formatDeleteHeader(start, end)).edits).text;
				expect(viaDel).toBe(remainingAfterDelete(start, end));
			});
		}
	}
});
