/**
 * Expand first/middle/last of 5-line file to 3 lines.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits expand corners of 5-line file", () => {
	const base = ["a", "b", "c", "d", "e"];
	const text = base.join("\n");
	const body = "+X\n+Y\n+Z";

	it("first", () => {
		const { text: out } = applyEdits(text, parsePatch(`SWAP 1.=1:\n${body}`).edits);
		expect(out).toBe("X\nY\nZ\nb\nc\nd\ne");
	});
	it("middle", () => {
		const { text: out } = applyEdits(text, parsePatch(`SWAP 3.=3:\n${body}`).edits);
		expect(out).toBe("a\nb\nX\nY\nZ\nd\ne");
	});
	it("last", () => {
		const { text: out } = applyEdits(text, parsePatch(`SWAP 5.=5:\n${body}`).edits);
		expect(out).toBe("a\nb\nc\nd\nX\nY\nZ");
	});
});
