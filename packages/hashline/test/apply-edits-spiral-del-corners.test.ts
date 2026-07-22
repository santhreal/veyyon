/**
 * n=9 grid as 9 lines: DEL four corners (indices 1,3,7,9).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits spiral DEL corners", () => {
	it("3x3 corners", () => {
		const base = "1\n2\n3\n4\n5\n6\n7\n8\n9";
		const { text } = applyEdits(base, parsePatch("DEL 1\nDEL 3\nDEL 7\nDEL 9").edits);
		expect(text.split("\n")).toEqual(["2", "4", "5", "6", "8"]);
	});
});
