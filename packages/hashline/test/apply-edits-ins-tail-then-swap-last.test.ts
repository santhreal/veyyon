/**
 * Sequential INS.TAIL then SWAP the new last line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits TAIL then SWAP last", () => {
	it("append then replace last", () => {
		const t1 = applyEdits("a", parsePatch("INS.TAIL:\n+b").edits).text;
		expect(t1).toBe("a\nb");
		const t2 = applyEdits(t1, parsePatch("SWAP 2.=2:\n+B").edits).text;
		expect(t2).toBe("a\nB");
	});
});
