/**
 * getEditAnchors / collectEditAnchorLines — recovery and mismatch need exact anchors.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, collectEditAnchorLines, getEditAnchors, parsePatch } from "@veyyon/hashline";

describe("getEditAnchors / collectEditAnchorLines", () => {
	it("delete anchors at the deleted line", () => {
		const edits = parsePatch("DEL 5").edits;
		expect(getEditAnchors(edits[0]!)).toEqual([{ line: 5 }]);
		expect(collectEditAnchorLines(edits)).toEqual([5]);
	});

	it("SWAP range collects every deleted line as anchors (insert may re-list start)", () => {
		const edits = parsePatch("SWAP 2.=4:\n+X").edits;
		// Deletes emit 2,3,4; the replacement insert also anchors at the range start,
		// so the raw list can contain a duplicate 2. Callers that need unique lines
		// dedupe; recovery uses the multiset for neighbor walks.
		const lines = collectEditAnchorLines(edits).sort((a, b) => a - b);
		expect(lines).toContain(2);
		expect(lines).toContain(3);
		expect(lines).toContain(4);
		expect([...new Set(lines)].sort((a, b) => a - b)).toEqual([2, 3, 4]);
	});

	it("INS.POST / INS.PRE anchor on the cursor line", () => {
		const post = parsePatch("INS.POST 7:\n+a").edits;
		expect(collectEditAnchorLines(post)).toEqual([7]);
		const pre = parsePatch("INS.PRE 3:\n+a").edits;
		expect(collectEditAnchorLines(pre)).toEqual([3]);
	});

	it("INS.HEAD / INS.TAIL contribute no content anchors", () => {
		expect(collectEditAnchorLines(parsePatch("INS.HEAD:\n+a").edits)).toEqual([]);
		expect(collectEditAnchorLines(parsePatch("INS.TAIL:\n+a").edits)).toEqual([]);
	});

	it("block edits anchor on the block line before resolve", () => {
		const edits = parsePatch("SWAP.BLK 9:\n+x").edits;
		expect(collectEditAnchorLines(edits)).toEqual([9]);
	});

	it("mixed ops union anchors without inventing head/tail", () => {
		const edits = parsePatch("DEL 1\nINS.POST 4:\n+x\nINS.HEAD:\n+h\nSWAP 6.=6:\n+y").edits;
		const lines = [...new Set(collectEditAnchorLines(edits))].sort((a, b) => a - b);
		expect(lines).toEqual([1, 4, 6]);
	});
});

describe("applyEdits exact outcomes for pure insert/delete combos", () => {
	it("DEL last line on multi-line file", () => {
		const text = "a\nb\nc";
		const { text: out } = applyEdits(text, parsePatch("DEL 3").edits);
		expect(out).toBe("a\nb");
	});

	it("DEL first line", () => {
		const { text: out } = applyEdits("a\nb\nc", parsePatch("DEL 1").edits);
		expect(out).toBe("b\nc");
	});

	it("INS.HEAD prepends in order", () => {
		const { text: out } = applyEdits("body", parsePatch("INS.HEAD:\n+H1\n+H2").edits);
		expect(out).toBe("H1\nH2\nbody");
	});

	it("INS.TAIL appends in order", () => {
		const { text: out } = applyEdits("body", parsePatch("INS.TAIL:\n+T1\n+T2").edits);
		expect(out).toBe("body\nT1\nT2");
	});

	it("INS.POST after last line appends", () => {
		const { text: out } = applyEdits("a\nb", parsePatch("INS.POST 2:\n+c").edits);
		expect(out).toBe("a\nb\nc");
	});

	it("INS.PRE before first line prepends", () => {
		const { text: out } = applyEdits("a\nb", parsePatch("INS.PRE 1:\n+z").edits);
		expect(out).toBe("z\na\nb");
	});

	it("SWAP single line preserves neighbors", () => {
		const { text: out } = applyEdits("a\nb\nc", parsePatch("SWAP 2.=2:\n+B").edits);
		expect(out).toBe("a\nB\nc");
	});

	it("SWAP expand middle grows file", () => {
		const { text: out } = applyEdits("a\nb\nc", parsePatch("SWAP 2.=2:\n+B1\n+B2\n+B3").edits);
		expect(out).toBe("a\nB1\nB2\nB3\nc");
	});

	it("SWAP shrink range removes lines", () => {
		const { text: out } = applyEdits("a\nb\nc\nd", parsePatch("SWAP 2.=3:\n+X").edits);
		expect(out).toBe("a\nX\nd");
	});

	it("empty file INS.HEAD creates content", () => {
		const { text: out } = applyEdits("", parsePatch("INS.HEAD:\n+only").edits);
		expect(out).toBe("only");
	});

	it("empty file INS.TAIL creates content", () => {
		const { text: out } = applyEdits("", parsePatch("INS.TAIL:\n+only").edits);
		expect(out).toBe("only");
	});
});
