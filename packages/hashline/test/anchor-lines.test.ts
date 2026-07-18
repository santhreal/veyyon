import { describe, expect, it } from "bun:test";
import { collectEditAnchorLines, getEditAnchors } from "../src/apply";
import type { Edit } from "../src/types";

// `getEditAnchors` is the single owner of "which lines does an edit anchor
// against", and `collectEditAnchorLines` is the single owner of walking a set
// of edits into their raw anchor-line list. `PatchSection.collectAnchorLines`
// (input.ts) and the recovery line-remap path both consume these instead of
// re-deriving the delete/block/before/after branching inline.

const del = (line: number): Edit => ({ kind: "delete", anchor: { line }, lineNum: line, index: 0 });
const block = (line: number): Edit => ({ kind: "block", anchor: { line }, payloads: [], lineNum: line, index: 0 });
const insBefore = (line: number): Edit => ({
	kind: "insert",
	cursor: { kind: "before_anchor", anchor: { line } },
	text: "x",
	lineNum: line,
	index: 0,
});
const insAfter = (line: number): Edit => ({
	kind: "insert",
	cursor: { kind: "after_anchor", anchor: { line } },
	text: "x",
	lineNum: line,
	index: 0,
});
const insBof: Edit = { kind: "insert", cursor: { kind: "bof" }, text: "x", lineNum: 0, index: 0 };
const insEof: Edit = { kind: "insert", cursor: { kind: "eof" }, text: "x", lineNum: 0, index: 0 };

describe("getEditAnchors", () => {
	it("returns the anchor line for delete and block edits", () => {
		expect(getEditAnchors(del(7)).map(a => a.line)).toEqual([7]);
		expect(getEditAnchors(block(3)).map(a => a.line)).toEqual([3]);
	});

	it("returns the cursor anchor for anchored inserts", () => {
		expect(getEditAnchors(insBefore(4)).map(a => a.line)).toEqual([4]);
		expect(getEditAnchors(insAfter(9)).map(a => a.line)).toEqual([9]);
	});

	it("returns no anchor for bof/eof inserts (file-relative, not line-anchored)", () => {
		expect(getEditAnchors(insBof)).toEqual([]);
		expect(getEditAnchors(insEof)).toEqual([]);
	});
});

describe("collectEditAnchorLines", () => {
	it("walks edits in order, keeping duplicates and dropping bof/eof", () => {
		const edits = [del(5), insBof, insAfter(5), block(2), insEof, insBefore(2)];
		expect(collectEditAnchorLines(edits)).toEqual([5, 5, 2, 2]);
	});

	it("is empty when every edit is file-relative", () => {
		expect(collectEditAnchorLines([insBof, insEof])).toEqual([]);
	});
});
