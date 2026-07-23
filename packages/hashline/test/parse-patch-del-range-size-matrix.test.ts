/**
 * parsePatch DEL N.=M produces exact delete line list.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch DEL range size matrix", () => {
	for (let start = 1; start <= 6; start++) {
		for (let end = start; end <= Math.min(start + 4, 10); end++) {
			it(`DEL ${start}.=${end}`, () => {
				const header = start === end ? `DEL ${start}` : `DEL ${start}.=${end}`;
				const { edits } = parsePatch(header);
				const lines = edits.filter(e => e.kind === "delete").map(e => (e.kind === "delete" ? e.anchor.line : 0));
				expect(lines).toEqual(Array.from({ length: end - start + 1 }, (_, i) => start + i));
			});
		}
	}
});
