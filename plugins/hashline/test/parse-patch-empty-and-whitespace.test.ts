import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

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

	// Trailing blank lines sit where payload rows would go. They must not be
	// absorbed as empty `+` payload, which would append blank lines to the file.
	it("trailing newlines after a valid SWAP contribute no payload", () => {
		const trailing = parsePatch("SWAP 1.=1:\n+x\n\n\n");
		expect(trailing.edits).toEqual(parsePatch("SWAP 1.=1:\n+x").edits);
		expect(applyEdits("a\nb", trailing.edits).text).toBe("x\nb");
	});
});
