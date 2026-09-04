/**
 * DEL lines 3,6,9 on a 9-line file leaves the rest.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits DEL every third line", () => {
	it("n=9 DEL 3,6,9", () => {
		const text = Array.from({ length: 9 }, (_, i) => String(i + 1)).join("\n");
		const { text: out } = applyEdits(text, parsePatch("DEL 3\nDEL 6\nDEL 9").edits);
		expect(out).toBe("1\n2\n4\n5\n7\n8");
	});

	it("n=6 DEL 2,4,6", () => {
		const text = Array.from({ length: 6 }, (_, i) => String(i + 1)).join("\n");
		const { text: out } = applyEdits(text, parsePatch("DEL 2\nDEL 4\nDEL 6").edits);
		expect(out).toBe("1\n3\n5");
	});
});
