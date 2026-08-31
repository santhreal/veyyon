/**
 * Sequential: INS.POST then SWAP the inserted line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.POST then SWAP inserted", () => {
	it("insert then replace X with Y", () => {
		const t1 = applyEdits("a\nb", parsePatch("INS.POST 1:\n+X").edits).text;
		expect(t1).toBe("a\nX\nb");
		const t2 = applyEdits(t1, parsePatch("SWAP 2.=2:\n+Y").edits).text;
		expect(t2).toBe("a\nY\nb");
	});
});
