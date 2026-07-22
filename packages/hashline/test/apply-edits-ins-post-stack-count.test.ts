/**
 * k sequential INS.POST at same original anchor via repeated applyEdits.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits sequential POST after line 1", () => {
	for (const k of [1, 2, 3, 5, 8]) {
		it(`k=${k}`, () => {
			let text = "A\nZ";
			for (let i = 0; i < k; i++) {
				// always POST after first line A
				text = applyEdits(text, parsePatch("INS.POST 1:\n+X").edits).text;
			}
			const lines = text.split("\n");
			expect(lines[0]).toBe("A");
			expect(lines[lines.length - 1]).toBe("Z");
			expect(lines.filter(l => l === "X")).toHaveLength(k);
			expect(lines.length).toBe(2 + k);
		});
	}
});
