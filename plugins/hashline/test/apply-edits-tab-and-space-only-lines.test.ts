/**
 * Lines that are only tabs/spaces are real content for DEL/SWAP.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits tab and space only lines", () => {
	it("SWAP space-only line", () => {
		const base = "a\n   \nc";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+\t\t").edits);
		expect(text).toBe("a\n\t\t\nc");
	});

	it("DEL tab-only line", () => {
		const base = "a\n\t\nc";
		const { text } = applyEdits(base, parsePatch("DEL 2").edits);
		expect(text).toBe("a\nc");
	});

	it("INS space-only body", () => {
		const base = "a\nb";
		const { text } = applyEdits(base, parsePatch("INS.POST 1:\n+   ").edits);
		expect(text.split("\n")[1]).toBe("   ");
	});
});
