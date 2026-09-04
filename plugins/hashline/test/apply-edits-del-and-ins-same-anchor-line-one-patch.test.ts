/**
 * DEL line and INS near same original indices in one multi-hunk patch.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL and INS same region one patch", () => {
	it("DEL 2 and INS.POST 1", () => {
		const base = "a\nb\nc";
		// remove b, insert after a (original indices)
		const { text } = applyEdits(base, parsePatch("DEL 2\nINS.POST 1:\n+X").edits);
		// concurrent original indices: DEL 2 removes b, POST 1 inserts after a
		expect(text.split("\n")).toContain("a");
		expect(text.split("\n")).toContain("X");
		expect(text.split("\n")).toContain("c");
		expect(text.split("\n")).not.toContain("b");
		expect(text.split("\n").length).toBe(3);
	});

	it("DEL 1 and INS.TAIL", () => {
		const base = "a\nb\nc";
		const { text } = applyEdits(base, parsePatch("DEL 1\nINS.TAIL:\n+Z").edits);
		expect(text).toBe("b\nc\nZ");
	});
});
