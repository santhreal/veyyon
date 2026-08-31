/**
 * Walk: for each original line, DEL it and INS.HEAD a marker — adversarial
 * sequential rewrites.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits interleave DEL INS walk", () => {
	it("replace all via del first + head insert chain", () => {
		let t = "a\nb\nc";
		t = apply(t, "DEL 1");
		t = apply(t, "INS.HEAD:\n+A");
		t = apply(t, "DEL 2");
		t = apply(t, "INS.POST 1:\n+B");
		t = apply(t, "DEL 3");
		t = apply(t, "INS.TAIL:\n+C");
		expect(t).toBe("A\nB\nC");
	});
});
