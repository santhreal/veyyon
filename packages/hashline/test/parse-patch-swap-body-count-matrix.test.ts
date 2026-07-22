/**
 * parsePatch SWAP body row count matches insert count for k=1..8.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch SWAP body count", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+L${i}`).join("\n");
			const { edits } = parsePatch(`SWAP 1.=1:\n${body}`);
			const ins = edits.filter(e => e.kind === "insert");
			expect(ins).toHaveLength(k);
			expect(ins.map(e => (e.kind === "insert" ? e.text : ""))).toEqual(
				Array.from({ length: k }, (_, i) => `L${i}`),
			);
		});
	}
});
