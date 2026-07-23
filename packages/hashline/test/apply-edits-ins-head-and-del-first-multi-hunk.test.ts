/**
 * Multi-hunk INS.HEAD and DEL original first line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits HEAD + DEL multi-hunk", () => {
	it("HEAD then DEL original line 1", () => {
		const { text } = applyEdits("a\nb", parsePatch("INS.HEAD:\n+H\nDEL 1").edits);
		expect(text.split("\n")).toContain("H");
		expect(text.split("\n")).toContain("b");
		expect(text.split("\n")).not.toContain("a");
	});
});
