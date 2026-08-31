/**
 * applyEdits preserves leading spaces and tabs in inserted bodies.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits preserves indentation", () => {
	const indents = ["  two", "    four", "\tone-tab", "\t\ttwo-tabs", " \tmixed"];

	for (const ind of indents) {
		it(`INS.TAIL ${JSON.stringify(ind)}`, () => {
			const { text } = applyEdits("x", parsePatch(`INS.TAIL:\n+${ind}`).edits);
			expect(text).toBe(`x\n${ind}`);
		});
		it(`SWAP ${JSON.stringify(ind)}`, () => {
			const { text } = applyEdits("x", parsePatch(`SWAP 1.=1:\n+${ind}`).edits);
			expect(text).toBe(ind);
		});
	}
});
