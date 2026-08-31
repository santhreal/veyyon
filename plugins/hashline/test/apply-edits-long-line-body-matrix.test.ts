/**
 * Long line bodies (1k+ chars) round-trip through SWAP without truncation.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits long line body matrix", () => {
	for (const len of [100, 1000, 5000]) {
		it(`SWAP body length ${len}`, () => {
			const body = "x".repeat(len);
			const base = "short\n";
			const { text } = applyEdits(base, parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(`${body}\n`);
			expect(text.split("\n")[0]!.length).toBe(len);
		});

		it(`INS.TAIL body length ${len}`, () => {
			const body = "y".repeat(len);
			const { text } = applyEdits("a", parsePatch(`INS.TAIL:\n+${body}`).edits);
			expect(text).toBe(`a\n${body}`);
		});
	}
});
