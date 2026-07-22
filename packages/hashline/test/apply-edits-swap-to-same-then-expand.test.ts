/**
 * Sequential identity SWAP then expand same line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits identity then expand", () => {
	it("SWAP identity then expand", () => {
		const t0 = "a\nb\nc";
		const t1 = applyEdits(t0, parsePatch("SWAP 2.=2:\n+b").edits).text;
		expect(t1).toBe(t0);
		const t2 = applyEdits(t1, parsePatch("SWAP 2.=2:\n+B1\n+B2").edits).text;
		expect(t2).toBe("a\nB1\nB2\nc");
	});
});
