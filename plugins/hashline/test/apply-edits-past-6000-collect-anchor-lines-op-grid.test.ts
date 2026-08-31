/**
 * collectEditAnchorLines: every op kind reports expected anchors on dense grid.
 * Why: anchor collection drives mismatch context; missing anchors hide recovery targets.
 * SWAP single line yields [line, line] (start+end); DEL range expands every line.
 */
import { describe, expect, it } from "bun:test";
import { collectEditAnchorLines, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 collect anchor lines op grid", () => {
	for (let line = 1; line <= 50; line++) {
		it(`DEL ${line} anchors [${line}]`, () => {
			const { edits } = parsePatch(`DEL ${line}`);
			expect(collectEditAnchorLines(edits)).toEqual([line]);
		});

		it(`SWAP ${line} anchors [${line},${line}]`, () => {
			const { edits } = parsePatch(`SWAP ${line}.=${line}:\n+x`);
			expect(collectEditAnchorLines(edits)).toEqual([line, line]);
		});

		it(`INS.POST ${line} anchors [${line}]`, () => {
			const { edits } = parsePatch(`INS.POST ${line}:\n+x`);
			expect(collectEditAnchorLines(edits)).toEqual([line]);
		});

		it(`INS.PRE ${line} anchors [${line}]`, () => {
			const { edits } = parsePatch(`INS.PRE ${line}:\n+x`);
			expect(collectEditAnchorLines(edits)).toEqual([line]);
		});
	}

	it("range DEL anchors every line in [start,end]", () => {
		const { edits } = parsePatch("DEL 3.=10");
		expect(collectEditAnchorLines(edits)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("range SWAP anchors start twice then interior then end", () => {
		const { edits } = parsePatch("SWAP 3.=5:\n+x");
		expect(collectEditAnchorLines(edits)).toEqual([3, 3, 4, 5]);
	});

	it("multi-hunk non-overlapping anchors in document order", () => {
		const { edits } = parsePatch("DEL 5\nDEL 2\nSWAP 8.=8:\n+z");
		expect(collectEditAnchorLines(edits)).toEqual([5, 2, 8, 8]);
	});

	it("HEAD and TAIL have no line anchors", () => {
		expect(collectEditAnchorLines(parsePatch("INS.HEAD:\n+h").edits)).toEqual([]);
		expect(collectEditAnchorLines(parsePatch("INS.TAIL:\n+t").edits)).toEqual([]);
	});
});
