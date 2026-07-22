/**
 * Control chars (tab, CR in middle, form feed) in body are preserved.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits control chars in body", () => {
	it("tab", () => {
		const { text } = applyEdits("old", parsePatch("SWAP 1.=1:\n+a\tb").edits);
		expect(text).toBe("a\tb");
	});

	it("carriage return mid-line", () => {
		const { text } = applyEdits("old", parsePatch("SWAP 1.=1:\n+a\rb").edits);
		expect(text).toBe("a\rb");
	});

	it("form feed", () => {
		const { text } = applyEdits("old", parsePatch("SWAP 1.=1:\n+a\fb").edits);
		expect(text).toBe("a\fb");
	});
});
