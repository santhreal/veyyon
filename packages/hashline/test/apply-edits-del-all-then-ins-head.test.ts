/**
 * DEL entire file then INS.HEAD on result is independent; combined multi-hunk on original anchors.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL all then INS.HEAD multi-hunk", () => {
	it("DEL 1.=3 then INS.HEAD on 3-line file yields only head content", () => {
		const { text } = applyEdits("a\nb\nc", parsePatch("DEL 1.=3\nINS.HEAD:\n+ONLY").edits);
		expect(text).toBe("ONLY");
	});

	it("INS.HEAD then DEL 1 removes original first not the head insert", () => {
		// Anchors against original: INS.HEAD adds, DEL 1 deletes original line 1
		const { text } = applyEdits("a\nb", parsePatch("INS.HEAD:\n+H\nDEL 1").edits);
		// Expected: H + (a deleted) + b => H\nb  or similar
		expect(text.split("\n")).toContain("H");
		expect(text.split("\n")).toContain("b");
		expect(text.split("\n")).not.toContain("a");
	});

	it("DEL last then INS.TAIL", () => {
		const { text } = applyEdits("a\nb\nc", parsePatch("DEL 3\nINS.TAIL:\n+T").edits);
		expect(text).toBe("a\nb\nT");
	});
});
