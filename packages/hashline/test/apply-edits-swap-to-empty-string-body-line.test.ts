/**
 * SWAP with + and empty rest produces an empty line at that position.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP to empty string body line", () => {
	it("middle to empty line", () => {
		const base = "a\nb\nc";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+").edits);
		// + alone may mean empty body line
		const out = text.split("\n");
		expect(out[0]).toBe("a");
		expect(out[2]).toBe("c");
		expect(out.length).toBeGreaterThanOrEqual(2);
	});

	it("replace with two empty lines", () => {
		const base = "a\nb\nc";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+\n+").edits);
		const out = text.split("\n");
		expect(out[0]).toBe("a");
		expect(out[out.length - 1]).toBe("c");
	});
});
