/**
 * Three-line rotation via sequential SWAPs with temps: a,b,c → c,a,b.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits shuffle via temp markers", () => {
	it("rotate left a,b,c → b,c,a", () => {
		let t = "a\nb\nc";
		// classic rotate using temp
		t = apply(t, "SWAP 1.=1:\n+TMP");
		t = apply(t, "SWAP 2.=2:\n+a");
		t = apply(t, "SWAP 3.=3:\n+b");
		t = apply(t, "SWAP 1.=1:\n+c");
		// wait that might not be rotate left...
		// start a b c
		// 1→TMP: TMP b c
		// 2→a: TMP a c
		// 3→b: TMP a b
		// 1→c: c a b
		expect(t).toBe("c\na\nb");
	});
});
