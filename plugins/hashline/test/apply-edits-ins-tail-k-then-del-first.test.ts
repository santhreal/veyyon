/**
 * INS.TAIL k lines then DEL first line on original then sequential.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.TAIL then DEL first sequential", () => {
	for (const k of [1, 2, 3, 5]) {
		it(`k=${k}`, () => {
			const body = Array.from({ length: k }, (_, i) => `+T${i}`).join("\n");
			const t1 = applyEdits("ONLY", parsePatch(`INS.TAIL:\n${body}`).edits).text;
			const wantTail = Array.from({ length: k }, (_, i) => `T${i}`);
			expect(t1).toBe(["ONLY", ...wantTail].join("\n"));
			const t2 = applyEdits(t1, parsePatch("DEL 1").edits).text;
			expect(t2).toBe(wantTail.join("\n"));
		});
	}
});
