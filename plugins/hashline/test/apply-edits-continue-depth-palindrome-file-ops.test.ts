/**
 * Palindrome-length content lines: reverse via sequential SWAPs.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits continue depth palindrome file ops", () => {
	it("reverse 5-line file via pairwise swap", () => {
		let t = "1\n2\n3\n4\n5";
		// swap 1↔5, 2↔4
		t = apply(t, "SWAP 1.=1:\n+TMP");
		t = apply(t, "SWAP 5.=5:\n+1");
		t = apply(t, "SWAP 1.=1:\n+5");
		t = apply(t, "SWAP 2.=2:\n+TMP2");
		t = apply(t, "SWAP 4.=4:\n+2");
		t = apply(t, "SWAP 2.=2:\n+4");
		expect(t).toBe("5\n4\n3\n2\n1");
	});
});
