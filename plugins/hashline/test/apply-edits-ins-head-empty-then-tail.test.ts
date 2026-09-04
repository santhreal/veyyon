/**
 * Empty file: INS.HEAD then INS.TAIL sequential.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits empty HEAD then TAIL", () => {
	it("builds H then T", () => {
		const t1 = applyEdits("", parsePatch("INS.HEAD:\n+H").edits).text;
		expect(t1).toBe("H");
		const t2 = applyEdits(t1, parsePatch("INS.TAIL:\n+T").edits).text;
		expect(t2).toBe("H\nT");
	});

	it("builds multi HEAD then multi TAIL", () => {
		const t1 = applyEdits("", parsePatch("INS.HEAD:\n+A\n+B").edits).text;
		const t2 = applyEdits(t1, parsePatch("INS.TAIL:\n+C\n+D").edits).text;
		expect(t2).toBe("A\nB\nC\nD");
	});
});
