/**
 * collectEditAnchorLines for DEL/SWAP/INS patches: exact anchor line lists.
 * Why: recovery remap keys off these anchors; wrong list fails recovery silently.
 */
import { describe, expect, it } from "bun:test";
import { collectEditAnchorLines, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 collect anchor lines from patches", () => {
	it("DEL single", () => {
		expect(collectEditAnchorLines(parsePatch("DEL 5").edits)).toEqual([5]);
	});

	it("DEL range expands per line", () => {
		expect(collectEditAnchorLines(parsePatch("DEL 2.=4").edits)).toEqual([2, 3, 4]);
	});

	it("SWAP range anchors deleted lines", () => {
		const lines = collectEditAnchorLines(parsePatch("SWAP 3.=5:\n+A\n+B").edits);
		// replacement inserts before anchor + deletes 3,4,5
		expect(lines).toContain(3);
		expect(lines).toContain(4);
		expect(lines).toContain(5);
	});

	it("INS.HEAD has no line anchors", () => {
		expect(collectEditAnchorLines(parsePatch("INS.HEAD:\n+H").edits)).toEqual([]);
	});

	it("INS.TAIL has no line anchors", () => {
		expect(collectEditAnchorLines(parsePatch("INS.TAIL:\n+T").edits)).toEqual([]);
	});

	it("INS.PRE anchors the target line", () => {
		expect(collectEditAnchorLines(parsePatch("INS.PRE 9:\n+R").edits)).toEqual([9]);
	});

	it("INS.POST anchors the target line", () => {
		expect(collectEditAnchorLines(parsePatch("INS.POST 9:\n+P").edits)).toEqual([9]);
	});

	it("multi-hunk order is edit order", () => {
		const lines = collectEditAnchorLines(
			parsePatch("DEL 10\nDEL 2\nINS.PRE 5:\n+X").edits,
		);
		expect(lines).toEqual([10, 2, 5]);
	});

	for (let n = 1; n <= 15; n++) {
		it(`DEL 1..=${n} expands to 1..${n}`, () => {
			const header = n === 1 ? "DEL 1" : `DEL 1.=${n}`;
			expect(collectEditAnchorLines(parsePatch(header).edits)).toEqual(
				Array.from({ length: n }, (_, i) => i + 1),
			);
		});
	}
});
