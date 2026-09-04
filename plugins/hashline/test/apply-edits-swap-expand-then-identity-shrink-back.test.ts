/**
 * Expand mid range then identity-shaped shrink back to original span content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits expand then identity shrink back", () => {
	it("expand 2..=3 then shrink expanded region to original two lines", () => {
		const base = "a\nb\nc\nd";
		let t = apply(base, "SWAP 2.=3:\n+X\n+Y\n+Z\n+W");
		expect(t).toBe("a\nX\nY\nZ\nW\nd");
		// restore b,c as two lines where X..W were
		t = apply(t, "SWAP 2.=5:\n+b\n+c");
		expect(t).toBe(base);
	});
});
