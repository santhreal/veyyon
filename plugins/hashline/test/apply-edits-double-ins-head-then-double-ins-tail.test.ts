/**
 * Sequential double HEAD then double TAIL: exact sandwich growth.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits double HEAD then double TAIL", () => {
	it("from body", () => {
		let t = "BODY";
		t = apply(t, "INS.HEAD:\n+H1");
		t = apply(t, "INS.HEAD:\n+H0");
		t = apply(t, "INS.TAIL:\n+T0");
		t = apply(t, "INS.TAIL:\n+T1");
		expect(t).toBe("H0\nH1\nBODY\nT0\nT1");
	});

	it("from empty", () => {
		let t = "";
		t = apply(t, "INS.HEAD:\n+A");
		t = apply(t, "INS.TAIL:\n+B");
		t = apply(t, "INS.HEAD:\n+0");
		t = apply(t, "INS.TAIL:\n+Z");
		expect(t).toBe("0\nA\nB\nZ");
	});
});
