/**
 * Smoke near 3900-test pure suite depth for SQLITE-DEPTH-2.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits 3900 suite smoke", () => {
	it("hash of apply result differs from base after swap", () => {
		const base = "a\nb\nc";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+X").edits);
		expect(computeFileHash(text)).not.toBe(computeFileHash(base));
		expect(text).toBe("a\nX\nc");
	});
});
