/**
 * Zigzag: DEL 1, INS.TAIL marker, repeat — drains file into reverse markers.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits zigzag DEL INS pattern", () => {
	it("drain a,b,c via del1 + tail", () => {
		let t = "a\nb\nc";
		t = apply(t, "DEL 1");
		t = apply(t, "INS.TAIL:\n+A");
		t = apply(t, "DEL 1");
		t = apply(t, "INS.TAIL:\n+B");
		t = apply(t, "DEL 1");
		t = apply(t, "INS.TAIL:\n+C");
		expect(t).toBe("A\nB\nC");
	});
});
