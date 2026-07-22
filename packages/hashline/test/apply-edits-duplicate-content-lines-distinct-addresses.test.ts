/**
 * Files with duplicate line content: ops address by line number not content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits duplicate content lines distinct addresses", () => {
	it("SWAP second of three identical lines", () => {
		const base = "x\nx\nx";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+Y").edits);
		expect(text).toBe("x\nY\nx");
	});

	it("DEL first of three identical", () => {
		const base = "x\nx\nx";
		expect(applyEdits(base, parsePatch("DEL 1").edits).text).toBe("x\nx");
	});

	it("DEL last of three identical", () => {
		const base = "x\nx\nx";
		expect(applyEdits(base, parsePatch("DEL 3").edits).text).toBe("x\nx");
	});
});
