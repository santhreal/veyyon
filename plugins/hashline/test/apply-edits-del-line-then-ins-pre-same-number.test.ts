/**
 * Sequential DEL 1 then INS.PRE 1 on remaining first line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL then PRE sequential", () => {
	it("DEL first then PRE before new first", () => {
		const t1 = applyEdits("a\nb\nc", parsePatch("DEL 1").edits).text;
		expect(t1).toBe("b\nc");
		const t2 = applyEdits(t1, parsePatch("INS.PRE 1:\n+X").edits).text;
		expect(t2).toBe("X\nb\nc");
	});
});
