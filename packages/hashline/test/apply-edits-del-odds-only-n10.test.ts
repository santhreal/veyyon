/**
 * DEL all odd lines of 10-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL odds n=10", () => {
	it("leaves evens", () => {
		const text = Array.from({ length: 10 }, (_, i) => String(i + 1)).join("\n");
		const patch = "DEL 1\nDEL 3\nDEL 5\nDEL 7\nDEL 9";
		const { text: out } = applyEdits(text, parsePatch(patch).edits);
		expect(out).toBe("2\n4\n6\n8\n10");
	});
});
