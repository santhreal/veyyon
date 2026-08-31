/**
 * parsePatch INS.PRE with k body rows yields k inserts.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch INS.PRE body count", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { edits } = parsePatch(`INS.PRE 3:\n${body}`);
			const ins = edits.filter(e => e.kind === "insert");
			expect(ins).toHaveLength(k);
			for (const e of ins) {
				if (e.kind === "insert") {
					expect(e.cursor.kind).toBe("before_anchor");
					if (e.cursor.kind === "before_anchor") expect(e.cursor.anchor.line).toBe(3);
				}
			}
		});
	}
});
