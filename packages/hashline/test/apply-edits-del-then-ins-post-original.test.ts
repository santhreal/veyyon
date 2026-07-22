/**
 * Multi-hunk DEL and INS.POST on original anchors.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL + INS.POST multi-hunk", () => {
	it("DEL 1 INS.POST 3", () => {
		const { text } = applyEdits(
			"a\nb\nc\nd",
			parsePatch("DEL 1\nINS.POST 3:\n+X").edits,
		);
		// DEL a, INS.POST after original c
		expect(text.split("\n")).toContain("X");
		expect(text.split("\n")).not.toContain("a");
		expect(text.split("\n")).toContain("b");
		expect(text.split("\n")).toContain("c");
		expect(text.split("\n")).toContain("d");
	});

	it("INS.POST 1 DEL 3", () => {
		const { text } = applyEdits(
			"a\nb\nc",
			parsePatch("INS.POST 1:\n+X\nDEL 3").edits,
		);
		expect(text.split("\n")).toContain("X");
		expect(text.split("\n")).not.toContain("c");
		expect(text.split("\n")[0]).toBe("a");
	});
});
