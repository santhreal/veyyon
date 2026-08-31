/**
 * To remove lines use DEL not empty SWAP body (documented contract).
 * Empty SWAP with zero + rows may throw EMPTY_REPLACE or be rejected at parse.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

describe("applyEdits shrink via DEL not empty SWAP", () => {
	it("DEL removes range", () => {
		const base = "a\nb\nc";
		expect(applyEdits(base, parsePatch("DEL 2").edits).text).toBe("a\nc");
	});

	it("SWAP with body is not delete", () => {
		const base = "a\nb\nc";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+x").edits);
		expect(text).toBe("a\nx\nc");
		expect(text).not.toBe("a\nc");
	});

	it("EMPTY_REPLACE message mentions DEL", () => {
		expect(EMPTY_REPLACE).toMatch(/DEL/);
	});
});
