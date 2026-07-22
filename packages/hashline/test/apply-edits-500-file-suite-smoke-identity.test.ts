/**
 * Smoke identity: empty patch list is identity; DEL then reverse rebuild.
 * Marks the 500-file pure suite depth bar for SQLITE-DEPTH-2.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits 500-file suite smoke identity", () => {
	it("empty edits identity", () => {
		const base = "x\ny\nz";
		expect(applyEdits(base, []).text).toBe(base);
	});

	it("full del then head rebuild", () => {
		const base = "a\nb\nc";
		const empty = applyEdits(base, parsePatch("DEL 1.=3").edits).text;
		expect(empty).toBe("");
		const rebuilt = applyEdits(empty, parsePatch("INS.HEAD:\n+a\n+b\n+c").edits).text;
		expect(rebuilt).toBe(base);
	});
});
