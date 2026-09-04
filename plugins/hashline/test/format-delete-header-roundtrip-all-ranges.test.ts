/**
 * formatDeleteHeader for all ranges on 1..5, round-trip through parsePatch.
 */
import { describe, expect, it } from "bun:test";
import { formatDeleteHeader, parsePatch } from "@veyyon/hashline";

describe("formatDeleteHeader round-trip ranges 1..5", () => {
	for (let start = 1; start <= 5; start++) {
		for (let end = start; end <= 5; end++) {
			it(`DEL ${start}..=${end}`, () => {
				const h = formatDeleteHeader(start, end);
				if (start === end) expect(h).toBe(`DEL ${start}`);
				else expect(h).toBe(`DEL ${start}.=${end}`);
				const { edits } = parsePatch(h);
				const lines = edits.filter(e => e.kind === "delete").map(e => (e.kind === "delete" ? e.anchor.line : 0));
				const want = Array.from({ length: end - start + 1 }, (_, i) => start + i);
				expect(lines).toEqual(want);
			});
		}
	}
});
