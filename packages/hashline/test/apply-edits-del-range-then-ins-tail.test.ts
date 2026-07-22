/**
 * DEL middle range then INS.TAIL in one multi-hunk.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL range then INS.TAIL", () => {
	it("DEL 2.=3 INS.TAIL", () => {
		const { text } = applyEdits(
			"a\nb\nc\nd",
			parsePatch("DEL 2.=3\nINS.TAIL:\n+T").edits,
		);
		expect(text).toBe("a\nd\nT");
	});

	it("DEL 1 INS.HEAD", () => {
		const { text } = applyEdits(
			"a\nb",
			parsePatch("DEL 1\nINS.HEAD:\n+H").edits,
		);
		expect(text).toBe("H\nb");
	});
});
