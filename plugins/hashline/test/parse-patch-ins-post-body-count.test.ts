/**
 * parsePatch INS.POST with k body rows yields k inserts.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch INS.POST body count", () => {
	for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+R${i}`).join("\n");
			const { edits } = parsePatch(`INS.POST 1:\n${body}`);
			expect(edits.filter(e => e.kind === "insert")).toHaveLength(k);
		});
	}
});
