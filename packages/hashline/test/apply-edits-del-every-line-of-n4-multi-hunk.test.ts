/**
 * DEL all lines of 4-line file as four DEL ops.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL all multi-hunk n=4", () => {
	it("empties", () => {
		const { text } = applyEdits("1\n2\n3\n4", parsePatch("DEL 1\nDEL 2\nDEL 3\nDEL 4").edits);
		expect(text).toBe("");
	});
});
