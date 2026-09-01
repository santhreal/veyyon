import { describe, expect, it } from "bun:test";
import { hasAnchorScopedEdit, hasBlockEdit } from "../src/block";
import type { Edit } from "../src/types";

function makeInsertEdit(cursorKind: string, lineNum = 1): Edit {
	return {
		kind: "insert",
		cursor: { kind: cursorKind } as Edit extends { cursor: infer C } ? C : never,
		text: "new text",
		lineNum,
		index: 0,
	} as unknown as Edit;
}

function makeDeleteEdit(line: number): Edit {
	return { kind: "delete", anchor: { line }, lineNum: line, index: 0 } as Edit;
}

function makeBlockEdit(line: number, payloads: string[] = []): Edit {
	return {
		kind: "block",
		anchor: { line },
		payloads,
		lineNum: line,
		index: 0,
	} as Edit;
}

describe("hasBlockEdit", () => {
	it("returns false for empty edits", () => {
		expect(hasBlockEdit([])).toBe(false);
	});
	it("returns false for insert edits only", () => {
		expect(hasBlockEdit([makeInsertEdit("bof")])).toBe(false);
	});
	it("returns false for delete edits only", () => {
		expect(hasBlockEdit([makeDeleteEdit(1)])).toBe(false);
	});
	it("returns true for block edit", () => {
		expect(hasBlockEdit([makeBlockEdit(1)])).toBe(true);
	});
	it("returns true when block edit is mixed with others", () => {
		expect(hasBlockEdit([makeInsertEdit("bof"), makeBlockEdit(1), makeDeleteEdit(2)])).toBe(true);
	});
});

describe("hasAnchorScopedEdit", () => {
	it("returns false for empty edits", () => {
		expect(hasAnchorScopedEdit([])).toBe(false);
	});
	it("returns true for delete edit", () => {
		expect(hasAnchorScopedEdit([makeDeleteEdit(1)])).toBe(true);
	});
	it("returns true for block edit", () => {
		expect(hasAnchorScopedEdit([makeBlockEdit(1)])).toBe(true);
	});
	it("returns true for before_anchor cursor", () => {
		expect(
			hasAnchorScopedEdit([
				{ kind: "insert", cursor: { kind: "before_anchor", anchor: { line: 1 } }, text: "x", lineNum: 1, index: 0 },
			]),
		).toBe(true);
	});
	it("returns true for after_anchor cursor", () => {
		expect(
			hasAnchorScopedEdit([
				{ kind: "insert", cursor: { kind: "after_anchor", anchor: { line: 1 } }, text: "x", lineNum: 1, index: 0 },
			]),
		).toBe(true);
	});
	it("returns false for bof cursor", () => {
		expect(hasAnchorScopedEdit([{ kind: "insert", cursor: { kind: "bof" }, text: "x", lineNum: 1, index: 0 }])).toBe(
			false,
		);
	});
	it("returns false for eof cursor", () => {
		expect(hasAnchorScopedEdit([{ kind: "insert", cursor: { kind: "eof" }, text: "x", lineNum: 1, index: 0 }])).toBe(
			false,
		);
	});
	it("returns true for mix with at least one anchor-scoped", () => {
		expect(
			hasAnchorScopedEdit([
				{ kind: "insert", cursor: { kind: "bof" }, text: "x", lineNum: 1, index: 0 },
				{ kind: "insert", cursor: { kind: "after_anchor", anchor: { line: 1 } }, text: "y", lineNum: 2, index: 1 },
			]),
		).toBe(true);
	});
	it("returns false for only bof and eof cursors", () => {
		expect(
			hasAnchorScopedEdit([
				{ kind: "insert", cursor: { kind: "bof" }, text: "x", lineNum: 1, index: 0 },
				{ kind: "insert", cursor: { kind: "eof" }, text: "y", lineNum: 2, index: 1 },
			]),
		).toBe(false);
	});
});
