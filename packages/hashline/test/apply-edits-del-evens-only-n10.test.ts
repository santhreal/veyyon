/**
 * DEL all even lines of 10-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL evens n=10", () => {
	it("leaves odds", () => {
		const text = Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n");
		const patch = "DEL 2\nDEL 4\nDEL 6\nDEL 8\nDEL 10";
		const { text: out } = applyEdits(text, parsePatch(patch).edits);
		expect(out).toBe("1\n3\n5\n7\n9");
	});
});
