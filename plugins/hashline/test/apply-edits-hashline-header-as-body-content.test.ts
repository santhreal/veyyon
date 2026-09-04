/**
 * A body line that looks like a section header is content, not a new section.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits hashline header as body content", () => {
	it("bracket path hash as body", () => {
		const body = "[src/foo.ts#ABCD]";
		const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
		expect(text).toBe(body);
	});

	it("numbered display line as body", () => {
		const body = "12:const x = 1;";
		const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
		expect(text).toBe(body);
	});
});
