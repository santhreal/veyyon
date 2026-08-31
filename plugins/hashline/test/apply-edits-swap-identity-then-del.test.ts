/**
 * Sequential identity SWAP then DEL that line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits identity then DEL", () => {
	it("SWAP identity then DEL", () => {
		const t0 = "a\nb\nc";
		const t1 = applyEdits(t0, parsePatch("SWAP 2.=2:\n+b").edits).text;
		expect(t1).toBe(t0);
		const t2 = applyEdits(t1, parsePatch("DEL 2").edits).text;
		expect(t2).toBe("a\nc");
	});
});
