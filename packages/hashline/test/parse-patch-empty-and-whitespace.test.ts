import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

/**
 * parsePatch on empty, whitespace-only, and comment-like inputs.
 */

describe("parsePatch empty and whitespace", () => {
	it("empty string yields zero edits", () => {
		const { edits, warnings } = parsePatch("");
		expect(edits).toEqual([]);
		expect(Array.isArray(warnings)).toBe(true);
	});

	it("whitespace-only yields zero edits or only warnings", () => {
		for (const s of ["   ", "\n\n", "\t\n  \n"]) {
			const { edits } = parsePatch(s);
			expect(edits).toEqual([]);
		}
	});

	it("trailing newlines after a valid SWAP are fine", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+x\n\n\n");
		expect(edits.length).toBeGreaterThan(0);
	});
});
