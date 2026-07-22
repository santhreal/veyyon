/**
 * INS.POST after each line with unique markers, then DEL all markers.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits continue depth interleave X markers", () => {
	it("insert then remove markers restore base", () => {
		const base = "a\nb\nc";
		const patch = "INS.POST 1:\n+X1\nINS.POST 2:\n+X2\nINS.POST 3:\n+X3";
		let t = apply(base, patch);
		expect(t).toBe("a\nX1\nb\nX2\nc\nX3");
		// remove markers at even positions 2,4,6
		t = apply(t, "DEL 2\nDEL 4\nDEL 6");
		expect(t).toBe(base);
	});
});
