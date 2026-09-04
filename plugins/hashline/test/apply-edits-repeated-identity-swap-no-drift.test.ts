/**
 * Applying the same identity SWAP 20 times leaves text unchanged every step.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits repeated identity SWAP no drift", () => {
	it("20× identity SWAP line 2", () => {
		const base = "a\nb\nc\nd";
		let t = base;
		const edits = parsePatch("SWAP 2.=2:\n+b").edits;
		for (let i = 0; i < 20; i++) {
			t = applyEdits(t, edits).text;
			expect(t).toBe(base);
		}
	});
});
