/**
 * collectEditAnchorLines unique sets for representative ops.
 */
import { describe, expect, it } from "bun:test";
import { collectEditAnchorLines, parsePatch } from "@veyyon/hashline";

function uniq(lines: number[]): number[] {
	return [...new Set(lines)].sort((a, b) => a - b);
}

describe("collectEditAnchorLines unique matrix", () => {
	it("DEL", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("DEL 7").edits))).toEqual([7]);
	});
	it("DEL range", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("DEL 2.=5").edits))).toEqual([2, 3, 4, 5]);
	});
	it("SWAP range", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("SWAP 3.=5:\n+X").edits))).toEqual([3, 4, 5]);
	});
	it("INS.POST", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("INS.POST 9:\n+x").edits))).toEqual([9]);
	});
	it("INS.PRE", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("INS.PRE 4:\n+x").edits))).toEqual([4]);
	});
	it("INS.HEAD empty anchors", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("INS.HEAD:\n+x").edits))).toEqual([]);
	});
	it("INS.TAIL empty anchors", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("INS.TAIL:\n+x").edits))).toEqual([]);
	});
	it("block", () => {
		expect(uniq(collectEditAnchorLines(parsePatch("SWAP.BLK 11:\n+x").edits))).toEqual([11]);
	});
	it("mixed", () => {
		expect(
			uniq(collectEditAnchorLines(parsePatch("DEL 1\nINS.POST 3:\n+x\nINS.HEAD:\n+h\nSWAP 5.=5:\n+y").edits)),
		).toEqual([1, 3, 5]);
	});
});
