/**
 * Files with blank lines: SWAP mid preserves blank lines outside the range.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP preserve blank lines outside range", () => {
	it("blank sandwich", () => {
		const base = "a\n\nb\n\nc";
		const { text } = applyEdits(base, parsePatch("SWAP 3.=3:\n+B").edits);
		expect(text).toBe("a\n\nB\n\nc");
	});

	it("leading blanks preserved", () => {
		const base = "\n\nx\ny";
		const { text } = applyEdits(base, parsePatch("SWAP 3.=3:\n+X").edits);
		expect(text).toBe("\n\nX\ny");
	});

	it("trailing blank preserved after swap earlier", () => {
		const base = "a\nb\n";
		const { text } = applyEdits(base, parsePatch("SWAP 1.=1:\n+A").edits);
		expect(text).toBe("A\nb\n");
	});
});
