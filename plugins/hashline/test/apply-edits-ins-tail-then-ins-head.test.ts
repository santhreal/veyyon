/**
 * Sequential INS.TAIL then INS.HEAD.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits TAIL then HEAD sequential", () => {
	it("TAIL then HEAD", () => {
		const t1 = applyEdits("mid", parsePatch("INS.TAIL:\n+T").edits).text;
		expect(t1).toBe("mid\nT");
		const t2 = applyEdits(t1, parsePatch("INS.HEAD:\n+H").edits).text;
		expect(t2).toBe("H\nmid\nT");
	});

	it("HEAD then TAIL", () => {
		const t1 = applyEdits("mid", parsePatch("INS.HEAD:\n+H").edits).text;
		const t2 = applyEdits(t1, parsePatch("INS.TAIL:\n+T").edits).text;
		expect(t2).toBe("H\nmid\nT");
	});
});
