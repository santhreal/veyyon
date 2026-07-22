/**
 * File of only spaces/tabs lines: DEL/SWAP by index still works.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits whitespace-only file ops", () => {
	it("three space lines DEL middle", () => {
		const base = " \n  \n   ";
		const { text } = applyEdits(base, parsePatch("DEL 2").edits);
		expect(text).toBe(" \n   ");
	});

	it("SWAP middle space line to tab-prefixed content", () => {
		const base = "a\n \nb";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+\tx").edits);
		expect(text).toBe("a\n\tx\nb");
	});
});
