/**
 * collectEditAnchorLines: order is edit order; multi-anchor ranges include
 * start; duplicates kept when same line appears twice.
 */
import { describe, expect, it } from "bun:test";
import { collectEditAnchorLines, parsePatch } from "@veyyon/hashline";

describe("collectEditAnchorLines order matrix", () => {
	it("DEL then SWAP order", () => {
		const edits = parsePatch("DEL 3\nSWAP 1.=2:\n+x").edits;
		const lines = collectEditAnchorLines(edits);
		expect(lines[0]).toBe(3);
		expect(lines).toContain(1);
	});

	it("INS.POST then INS.PRE", () => {
		const edits = parsePatch("INS.POST 5:\n+a\nINS.PRE 2:\n+b").edits;
		const lines = collectEditAnchorLines(edits);
		expect(lines).toEqual([5, 2]);
	});

	it("duplicate DEL same line fails at parse (one hunk per range)", () => {
		expect(() => parsePatch("DEL 1\nDEL 1")).toThrow(/already targeted|ONE hunk/i);
	});

	it("same line via DEL and SWAP range fails or lists both when parse allows", () => {
		// DEL 2 + INS.POST 2 is multi-hunk different kinds — anchors both 2
		const edits = parsePatch("DEL 3\nINS.POST 3:\n+x").edits;
		expect(collectEditAnchorLines(edits)).toEqual([3, 3]);
	});

	it("empty edits", () => {
		expect(collectEditAnchorLines([])).toEqual([]);
	});

	it("HEAD/TAIL may contribute no numeric anchors", () => {
		const edits = parsePatch("INS.HEAD:\n+x\nINS.TAIL:\n+y").edits;
		const lines = collectEditAnchorLines(edits);
		// bof/eof cursors have no line anchors
		expect(Array.isArray(lines)).toBe(true);
		for (const n of lines) expect(typeof n).toBe("number");
	});

	for (const n of [1, 3, 5, 8]) {
		it(`DEL every line 1..${n} multi-hunk`, () => {
			const patch = Array.from({ length: n }, (_, i) => `DEL ${i + 1}`).join("\n");
			expect(collectEditAnchorLines(parsePatch(patch).edits)).toEqual(
				Array.from({ length: n }, (_, i) => i + 1),
			);
		});
	}
});
