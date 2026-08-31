/**
 * Expand line 1 of 3-line file to 6 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand first of 3 to 6", () => {
	it("k=6", () => {
		const body = Array.from({ length: 6 }, (_, i) => `+E${i}`).join("\n");
		const { text } = applyEdits("a\nb\nc", parsePatch(`SWAP 1.=1:\n${body}`).edits);
		const mid = Array.from({ length: 6 }, (_, i) => `E${i}`);
		expect(text).toBe([...mid, "b", "c"].join("\n"));
	});
});
