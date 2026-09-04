/**
 * Sequential DEL first then SWAP new first line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL then SWAP remaining first", () => {
	it("DEL 1 then SWAP 1", () => {
		const t1 = applyEdits("a\nb\nc", parsePatch("DEL 1").edits).text;
		expect(t1).toBe("b\nc");
		const t2 = applyEdits(t1, parsePatch("SWAP 1.=1:\n+B").edits).text;
		expect(t2).toBe("B\nc");
	});
});
