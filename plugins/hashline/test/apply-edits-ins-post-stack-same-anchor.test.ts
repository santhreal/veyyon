/**
 * Multiple INS.POST same original anchor in one parse.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits stacked INS.POST same anchor", () => {
	it("two INS.POST 1", () => {
		const { text } = applyEdits("a\nb", parsePatch("INS.POST 1:\n+X\nINS.POST 1:\n+Y").edits);
		expect(text.split("\n")[0]).toBe("a");
		expect(text).toContain("X");
		expect(text).toContain("Y");
		expect(text.split("\n")).toContain("b");
		expect(text.split("\n").length).toBe(4);
	});

	it("three INS.POST last line", () => {
		const { text } = applyEdits("only", parsePatch("INS.POST 1:\n+1\nINS.POST 1:\n+2\nINS.POST 1:\n+3").edits);
		expect(text.split("\n")[0]).toBe("only");
		expect(text.split("\n").length).toBe(4);
		expect(text).toContain("1");
		expect(text).toContain("2");
		expect(text).toContain("3");
	});
});
