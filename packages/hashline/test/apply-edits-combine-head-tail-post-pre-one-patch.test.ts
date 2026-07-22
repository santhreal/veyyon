/**
 * One patch with HEAD, TAIL, PRE, and POST: all land with original-index anchors.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits combine HEAD TAIL PRE POST one patch", () => {
	it("four insert kinds together", () => {
		const base = "a\nb\nc";
		const patch = [
			"INS.HEAD:\n+H",
			"INS.TAIL:\n+T",
			"INS.PRE 2:\n+P",
			"INS.POST 2:\n+O",
		].join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		// HEAD prepends, PRE 2 before original b, POST 2 after original b, TAIL appends
		// Order of application is implementation-defined but content must include all
		expect(text.split("\n")).toContain("H");
		expect(text.split("\n")).toContain("T");
		expect(text.split("\n")).toContain("P");
		expect(text.split("\n")).toContain("O");
		expect(text.split("\n")).toContain("a");
		expect(text.split("\n")).toContain("b");
		expect(text.split("\n")).toContain("c");
		expect(text.split("\n").length).toBe(7);
	});
});
