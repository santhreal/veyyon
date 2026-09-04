/**
 * DEL every even line of an 8-line file in one multi-hunk parse.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL even lines multi-hunk", () => {
	it("DEL 2,4,6,8 leaves odds", () => {
		const text = Array.from({ length: 8 }, (_, i) => String(i + 1)).join("\n");
		const patch = "DEL 2\nDEL 4\nDEL 6\nDEL 8";
		const { text: out } = applyEdits(text, parsePatch(patch).edits);
		expect(out).toBe("1\n3\n5\n7");
	});

	it("DEL odds leaves evens", () => {
		const text = Array.from({ length: 8 }, (_, i) => String(i + 1)).join("\n");
		const patch = "DEL 1\nDEL 3\nDEL 5\nDEL 7";
		const { text: out } = applyEdits(text, parsePatch(patch).edits);
		expect(out).toBe("2\n4\n6\n8");
	});
});
