/**
 * INS.HEAD k lines then DEL last content line (the original body).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.HEAD then DEL original body", () => {
	for (const k of [1, 2, 4, 6]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+H${i}`).join("\n");
			const t1 = applyEdits("BODY", parsePatch(`INS.HEAD:\n${body}`).edits).text;
			const heads = Array.from({ length: k }, (_, i) => `H${i}`);
			expect(t1).toBe([...heads, "BODY"].join("\n"));
			// BODY is at line k+1
			const t2 = applyEdits(t1, parsePatch(`DEL ${k + 1}`).edits).text;
			expect(t2).toBe(heads.join("\n"));
		});
	}
});
