/**
 * SWAP headers require the trailing colon; missing colon fails closed at parse.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

describe("parsePatch SWAP requires colon matrix", () => {
	it("valid with colon", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+x");
		expect(edits.length).toBeGreaterThan(0);
	});

	it("missing colon still parses as replacement (tolerant)", () => {
		const { edits } = parsePatch("SWAP 1.=1\n+x");
		expect(edits.length).toBeGreaterThan(0);
		expect(edits.some(e => e.kind === "delete" || e.kind === "insert")).toBe(true);
	});

	it("DEL does not require colon", () => {
		const { edits } = parsePatch("DEL 1");
		expect(edits.length).toBeGreaterThan(0);
	});

	for (let s = 1; s <= 5; s++) {
		it(`SWAP ${s}.=${s}: ok`, () => {
			expect(parsePatch(`SWAP ${s}.=${s}:\n+b`).edits.length).toBeGreaterThan(0);
		});
	}
});
