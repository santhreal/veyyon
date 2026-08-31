/**
 * Smoke at 600 pure test files for SQLITE-DEPTH-2.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

describe("applyEdits 600 file suite smoke", () => {
	it("apply changes hash", () => {
		const base = "stable\ncontent";
		const h0 = computeFileHash(base);
		const { text } = applyEdits(base, parsePatch("INS.TAIL:\n+x").edits);
		expect(computeFileHash(text)).not.toBe(h0);
	});
});
