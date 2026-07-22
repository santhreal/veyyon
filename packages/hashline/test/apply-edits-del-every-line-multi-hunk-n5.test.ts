/**
 * DEL all five lines as five single DEL ops in one multi-hunk.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL every line multi-hunk n=5", () => {
	it("DEL 1..5 empties", () => {
		const text = "1\n2\n3\n4\n5";
		const { text: out } = applyEdits(
			text,
			parsePatch("DEL 1\nDEL 2\nDEL 3\nDEL 4\nDEL 5").edits,
		);
		expect(out).toBe("");
	});
});
