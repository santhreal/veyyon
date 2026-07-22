/**
 * Sequential: SWAP line to blank, then SWAP blank to content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits blank intermediate then fill", () => {
	it("clear middle then fill", () => {
		const t0 = "a\nb\nc";
		const t1 = applyEdits(t0, parsePatch("SWAP 2.=2:\n+").edits).text;
		expect(t1).toBe("a\n\nc");
		const t2 = applyEdits(t1, parsePatch("SWAP 2.=2:\n+B").edits).text;
		expect(t2).toBe("a\nB\nc");
	});

	it("clear all three then fill first", () => {
		const t0 = "a\nb\nc";
		const t1 = applyEdits(t0, parsePatch("SWAP 1.=3:\n+").edits).text;
		expect(t1).toBe("");
		const t2 = applyEdits(t1, parsePatch("INS.HEAD:\n+only").edits).text;
		expect(t2).toBe("only");
	});
});
