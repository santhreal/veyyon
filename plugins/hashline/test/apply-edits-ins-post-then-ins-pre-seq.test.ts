/**
 * Sequential INS.POST then INS.PRE on resulting file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits POST then PRE sequential", () => {
	it("POST after 1 then PRE before 1", () => {
		const t1 = applyEdits("a\nb", parsePatch("INS.POST 1:\n+X").edits).text;
		expect(t1).toBe("a\nX\nb");
		const t2 = applyEdits(t1, parsePatch("INS.PRE 1:\n+P").edits).text;
		expect(t2).toBe("P\na\nX\nb");
	});
});
