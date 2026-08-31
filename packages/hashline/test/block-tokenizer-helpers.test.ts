import { describe, expect, it } from "bun:test";
import { hasAnchorScopedEdit, hasBlockEdit } from "../src/block";
import { Tokenizer } from "../src/tokenizer";
import type { Edit } from "../src/types";

function makeLineEdit(line: number, kind: Edit["kind"] = "insert"): Edit {
	return {
		kind,
		anchor: { line },
		cursor: { kind: "anchor", line },
		lineNum: line,
		index: 0,
		payloads: [],
	} as unknown as Edit;
}

describe("hasBlockEdit", () => {
	it("returns true when block edit present", () => {
		const edits: Edit[] = [
			makeLineEdit(1),
			{ kind: "block", anchor: { line: 2 }, lineNum: 2, index: 1, mode: "replace", payloads: [] } as unknown as Edit,
		];
		expect(hasBlockEdit(edits)).toBe(true);
	});

	it("returns false when no block edit", () => {
		const edits: Edit[] = [makeLineEdit(1), makeLineEdit(2)];
		expect(hasBlockEdit(edits)).toBe(false);
	});

	it("returns false for empty array", () => {
		expect(hasBlockEdit([])).toBe(false);
	});
});

describe("hasAnchorScopedEdit", () => {
	it("returns true for delete edit", () => {
		const edits: Edit[] = [makeLineEdit(1, "delete")];
		expect(hasAnchorScopedEdit(edits)).toBe(true);
	});

	it("returns true for block edit", () => {
		const edits: Edit[] = [
			{ kind: "block", anchor: { line: 1 }, lineNum: 1, index: 0, mode: "replace", payloads: [] } as unknown as Edit,
		];
		expect(hasAnchorScopedEdit(edits)).toBe(true);
	});

	it("returns true for before_anchor cursor", () => {
		const edits: Edit[] = [
			{
				kind: "insert",
				cursor: { kind: "before_anchor", line: 1 },
				lineNum: 1,
				index: 0,
				payloads: [],
			} as unknown as Edit,
		];
		expect(hasAnchorScopedEdit(edits)).toBe(true);
	});

	it("returns true for after_anchor cursor", () => {
		const edits: Edit[] = [
			{
				kind: "insert",
				cursor: { kind: "after_anchor", line: 1 },
				lineNum: 1,
				index: 0,
				payloads: [],
			} as unknown as Edit,
		];
		expect(hasAnchorScopedEdit(edits)).toBe(true);
	});

	it("returns false for plain insert edit with anchor cursor", () => {
		const edits: Edit[] = [makeLineEdit(1, "insert")];
		expect(hasAnchorScopedEdit(edits)).toBe(false);
	});

	it("returns false for empty array", () => {
		expect(hasAnchorScopedEdit([])).toBe(false);
	});
});

describe("Tokenizer", () => {
	it("feeds and drains complete lines", () => {
		const tokenizer = new Tokenizer();
		const tokens = tokenizer.feed("hello\nworld\n");
		expect(tokens).toHaveLength(2);
	});

	it("buffers incomplete line", () => {
		const tokenizer = new Tokenizer();
		const tokens = tokenizer.feed("hello\nwor");
		expect(tokens).toHaveLength(1);
	});

	it("flushes remaining buffer on end()", () => {
		const tokenizer = new Tokenizer();
		tokenizer.feed("hello\nwor");
		const remaining = tokenizer.end();
		expect(remaining).toHaveLength(1);
	});

	it("returns empty for empty chunk", () => {
		const tokenizer = new Tokenizer();
		expect(tokenizer.feed("")).toEqual([]);
	});

	it("throws when feed is called after end", () => {
		const tokenizer = new Tokenizer();
		tokenizer.end();
		expect(() => tokenizer.feed("hello")).toThrow();
	});

	it("reset allows reuse", () => {
		const tokenizer = new Tokenizer();
		tokenizer.end();
		tokenizer.reset();
		expect(() => tokenizer.feed("hello\n")).not.toThrow();
	});

	it("tokenizeAll processes entire text", () => {
		const tokenizer = new Tokenizer();
		const tokens = tokenizer.tokenizeAll("a\nb\nc");
		expect(tokens).toHaveLength(3);
	});

	it("tokenizeAll handles empty text", () => {
		const tokenizer = new Tokenizer();
		const tokens = tokenizer.tokenizeAll("");
		expect(tokens).toHaveLength(0);
	});

	it("tokenize single line", () => {
		const tokenizer = new Tokenizer();
		const token = tokenizer.tokenize("hello", 1);
		expect(token).toBeDefined();
		expect(token.lineNum).toBe(1);
	});

	it("handles CRLF line endings", () => {
		const tokenizer = new Tokenizer();
		const tokens = tokenizer.feed("hello\r\nworld\r\n");
		expect(tokens).toHaveLength(2);
	});

	it("end returns empty when buffer is empty", () => {
		const tokenizer = new Tokenizer();
		tokenizer.feed("hello\n");
		expect(tokenizer.end()).toEqual([]);
	});

	it("end returns empty when already closed", () => {
		const tokenizer = new Tokenizer();
		tokenizer.end();
		expect(tokenizer.end()).toEqual([]);
	});

	it("end strips trailing CR", () => {
		const tokenizer = new Tokenizer();
		tokenizer.feed("hello");
		const tokens = tokenizer.end();
		expect(tokens).toHaveLength(1);
	});

	it("isHeader returns true for header lines", () => {
		const tokenizer = new Tokenizer();
		expect(typeof tokenizer.isHeader("[file.ts#ABCD]")).toBe("boolean");
	});

	it("isOp returns true for hunk header lines", () => {
		const tokenizer = new Tokenizer();
		expect(typeof tokenizer.isOp("SWAP 1.=3:")).toBe("boolean");
	});

	it("isEnvelopeMarker returns boolean", () => {
		const tokenizer = new Tokenizer();
		expect(typeof tokenizer.isEnvelopeMarker("begin-patch")).toBe("boolean");
	});
});
