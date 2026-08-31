/**
 * parsePatch SWAP N.=M: produces M-N+1 deletes and body insert count.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch SWAP range size matrix", () => {
	for (let start = 1; start <= 5; start++) {
		for (let end = start; end <= start + 3; end++) {
			it(`SWAP ${start}.=${end} with 2 body rows`, () => {
				const { edits } = parsePatch(`SWAP ${start}.=${end}:\n+A\n+B`);
				const dels = edits.filter(e => e.kind === "delete");
				const ins = edits.filter(e => e.kind === "insert");
				expect(dels).toHaveLength(end - start + 1);
				expect(ins).toHaveLength(2);
				expect(ins.map(e => (e.kind === "insert" ? e.text : ""))).toEqual(["A", "B"]);
				const lines = dels.map(e => (e.kind === "delete" ? e.anchor.line : 0));
				expect(lines).toEqual(Array.from({ length: end - start + 1 }, (_, i) => start + i));
			});
		}
	}
});
