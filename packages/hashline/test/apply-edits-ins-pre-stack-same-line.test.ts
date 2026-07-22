/**
 * Multiple INS.PRE same original line in one parse.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits stacked INS.PRE same anchor", () => {
	it("two PRE 1", () => {
		const { text } = applyEdits(
			"body",
			parsePatch("INS.PRE 1:\n+A\nINS.PRE 1:\n+B").edits,
		);
		expect(text.split("\n")).toContain("A");
		expect(text.split("\n")).toContain("B");
		expect(text.split("\n")[text.split("\n").length - 1]).toBe("body");
		expect(text.split("\n").length).toBe(3);
	});

	it("three PRE middle", () => {
		const { text } = applyEdits(
			"a\nb\nc",
			parsePatch("INS.PRE 2:\n+1\nINS.PRE 2:\n+2\nINS.PRE 2:\n+3").edits,
		);
		expect(text.split("\n")[0]).toBe("a");
		expect(text.split("\n")).toContain("b");
		expect(text.split("\n")).toContain("c");
		expect(text.split("\n").length).toBe(6);
	});
});
