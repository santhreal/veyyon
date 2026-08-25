/**
 * `applyEdits` must never see a still-deferred `kind: "block"` edit.
 *
 * WHY THIS SUITE EXISTS. Parser output for `SWAP.BLK` / `DEL.BLK` /
 * `INS.BLK.POST` is a deferred `block` node. `resolveBlockEdits` is the only
 * owner of turning that into inserts+deletes once file text + language exist.
 * If the applier is reached with the deferred node still present, that is a
 * wiring bug in the patcher — not an authored-input error the model can fix
 * by rewriting the hunk. The throw is `UNRESOLVED_BLOCK_INTERNAL`, the same
 * string the messages module publishes, so a caller that catches `Error` and
 * surfaces `.message` names the missing `resolveBlockEdits` call rather than
 * a generic "bad edit".
 *
 * WHAT THIS IS NOT. A failed tree-sitter resolution is a different path
 * (`blockUnresolvedMessage`). That one is authored-input. This suite never
 * asks the resolver anything: the applier is reached with a raw `block` and
 * must refuse before it splits lines or mutates anything.
 */
import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	collectEditAnchorLines,
	collectRewrittenAnchorLines,
	editRewritesItsAnchor,
	getEditAnchors,
} from "../src/apply";
import { UNRESOLVED_BLOCK_INTERNAL } from "../src/messages";
import type { Edit } from "../src/types";

function blockEdit(line: number, payloads: string[], mode?: "insert_after"): Edit {
	return {
		kind: "block",
		anchor: { line },
		payloads,
		mode,
		lineNum: line,
		index: 0,
	};
}

function insertBof(text: string): Edit {
	return { kind: "insert", cursor: { kind: "bof" }, text, lineNum: 1, index: 0 };
}

function insertEof(text: string): Edit {
	return { kind: "insert", cursor: { kind: "eof" }, text, lineNum: 1, index: 0 };
}

function deleteLine(line: number): Edit {
	return { kind: "delete", anchor: { line }, lineNum: line, index: 0 };
}

function replacement(line: number, text: string): Edit {
	return {
		kind: "insert",
		cursor: { kind: "before_anchor", anchor: { line } },
		text,
		lineNum: line,
		index: 0,
		mode: "replacement",
	};
}

describe("applyEdits refuses an unresolved block before touching the body", () => {
	it("throws the internal wiring string for a replace_block node", () => {
		expect(() => applyEdits("alpha\nbeta\n", [blockEdit(1, ["NEW"])])).toThrow(UNRESOLVED_BLOCK_INTERNAL);
	});

	it("throws the same string for a delete_block node (empty payloads)", () => {
		expect(() => applyEdits("alpha\nbeta\n", [blockEdit(2, [])])).toThrow(UNRESOLVED_BLOCK_INTERNAL);
	});

	it("throws the same string for insert_after_block (mode insert_after)", () => {
		expect(() => applyEdits("alpha\nbeta\n", [blockEdit(1, ["after"], "insert_after")])).toThrow(
			UNRESOLVED_BLOCK_INTERNAL,
		);
	});

	it("throws when the block is the last edit after a well-formed delete", () => {
		expect(() => applyEdits("a\nb\nc\n", [deleteLine(2), blockEdit(3, ["z"])])).toThrow(UNRESOLVED_BLOCK_INTERNAL);
	});

	it("throws when the block sits between two inserts", () => {
		expect(() => applyEdits("body\n", [insertBof("H"), blockEdit(1, ["mid"]), insertEof("T")])).toThrow(
			UNRESOLVED_BLOCK_INTERNAL,
		);
	});

	it("throws even when the file is empty (no line to resolve against anyway)", () => {
		expect(() => applyEdits("", [blockEdit(1, ["x"])])).toThrow(UNRESOLVED_BLOCK_INTERNAL);
	});

	it("throws even when payloads look like already-resolved replacement lines", () => {
		expect(() => applyEdits("a\n", [blockEdit(1, ["a", "b", "c"])])).toThrow(UNRESOLVED_BLOCK_INTERNAL);
	});
});

describe("applyEdits empty list is identity, including the same string object", () => {
	it("returns the input string by reference when there are no edits", () => {
		const text = "untouched\nbody\n";
		const result = applyEdits(text, []);
		expect(result.text).toBe(text);
		expect(result.firstChangedLine).toBeUndefined();
		expect(result.warnings).toBeUndefined();
	});

	it("does not treat a missing edits array as a block — callers pass []", () => {
		const result = applyEdits("x", []);
		expect(result).toEqual({ text: "x", firstChangedLine: undefined });
	});
});

describe("getEditAnchors / rewrite classification for a deferred block", () => {
	it("a replace_block anchors the opening line", () => {
		const edit = blockEdit(7, ["body"]);
		expect(getEditAnchors(edit)).toEqual([{ line: 7 }]);
		expect(collectEditAnchorLines([edit])).toEqual([7]);
	});

	it("an insert_after_block still rewrites its anchor — span is a content claim", () => {
		const edit = blockEdit(4, ["after"], "insert_after");
		expect(editRewritesItsAnchor(edit)).toBe(true);
		expect([...collectRewrittenAnchorLines([edit])]).toEqual([4]);
	});

	it("a pure INS.HEAD does not rewrite any anchor (no anchor at all)", () => {
		const edit = insertBof("h");
		expect(getEditAnchors(edit)).toEqual([]);
		expect(editRewritesItsAnchor(edit)).toBe(false);
		expect(collectRewrittenAnchorLines([edit]).size).toBe(0);
	});

	it("a pure INS.TAIL does not rewrite any anchor", () => {
		const edit = insertEof("t");
		expect(getEditAnchors(edit)).toEqual([]);
		expect(editRewritesItsAnchor(edit)).toBe(false);
	});

	it("a replacement insert rewrites its before_anchor line", () => {
		const edit = replacement(3, "NEW");
		expect(editRewritesItsAnchor(edit)).toBe(true);
		expect(collectEditAnchorLines([edit])).toEqual([3]);
	});

	it("a delete rewrites its line", () => {
		const edit = deleteLine(9);
		expect(editRewritesItsAnchor(edit)).toBe(true);
		expect(getEditAnchors(edit)).toEqual([{ line: 9 }]);
	});

	it("collectEditAnchorLines keeps duplicate anchors in edit order", () => {
		const edits = [deleteLine(2), replacement(2, "x"), blockEdit(2, ["y"])];
		expect(collectEditAnchorLines(edits)).toEqual([2, 2, 2]);
	});
});
