/**
 * Sequential expand then shrink middle line.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand then shrink sequential", () => {
	it("expand 2 then shrink 2..=4 back to one", () => {
		const t0 = "a\nb\nc";
		const t1 = applyEdits(t0, parsePatch("SWAP 2.=2:\n+B1\n+B2\n+B3").edits).text;
		expect(t1).toBe("a\nB1\nB2\nB3\nc");
		const t2 = applyEdits(t1, parsePatch("SWAP 2.=4:\n+b").edits).text;
		expect(t2).toBe("a\nb\nc");
	});
});
