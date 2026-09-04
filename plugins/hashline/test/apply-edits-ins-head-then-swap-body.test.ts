/**
 * Sequential INS.HEAD then SWAP of the original first line (now shifted).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.HEAD then SWAP original body", () => {
	it("HEAD then SWAP line 2 (was line 1)", () => {
		const t1 = applyEdits("body\n", parsePatch("INS.HEAD:\n+H").edits).text;
		expect(t1).toBe("H\nbody\n");
		const t2 = applyEdits(t1, parsePatch("SWAP 2.=2:\n+BODY").edits).text;
		expect(t2).toBe("H\nBODY\n");
	});
});
