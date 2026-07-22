/**
 * INS.PRE and INS.POST on same original line: both land around that line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits INS.PRE+POST same anchor", () => {
	it("PRE and POST line 2 sandwich original line 2", () => {
		const { text } = applyEdits(
			"a\nb\nc",
			parsePatch("INS.PRE 2:\n+PRE\nINS.POST 2:\n+POST").edits,
		);
		// Both anchors are original line 2
		expect(text.split("\n")).toContain("PRE");
		expect(text.split("\n")).toContain("POST");
		expect(text.split("\n")).toContain("b");
		expect(text.split("\n")[0]).toBe("a");
		expect(text.split("\n")[text.split("\n").length - 1]).toBe("c");
	});

	it("PRE and POST line 1", () => {
		const { text } = applyEdits("only", parsePatch("INS.PRE 1:\n+P\nINS.POST 1:\n+Q").edits);
		expect(text).toBe("P\nonly\nQ");
	});
});
