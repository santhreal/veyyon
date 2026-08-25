/**
 * firstChangedLine for edge inserts is the live line after apply, not the
 * pre-edit address.
 *
 * WHY THIS SUITE EXISTS. BOF inserts always land on line 1 of the result
 * (`trackFirstChanged(1)` after `insertAtStart`). EOF inserts use
 * `insertAtEnd`'s returned line, which is the first newly appended line in
 * the rebuilt file — not "N+1 of the original" when the original ended in a
 * trailing empty line from `split("\\n")`. A test that only checks a middle
 * SWAP cannot catch a regression that reports the pre-edit last line for a
 * tail insert, which is what a follow-up `read` then highlights.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits } from "../src/apply";
import type { Edit } from "../src/types";

function bof(text: string): Edit {
	return { kind: "insert", cursor: { kind: "bof" }, text, lineNum: 1, index: 0 };
}
function eof(text: string): Edit {
	return { kind: "insert", cursor: { kind: "eof" }, text, lineNum: 1, index: 0 };
}

describe("INS.HEAD reports firstChangedLine 1", () => {
	it("on a non-empty file", () => {
		const result = applyEdits("a\nb", [bof("H")]);
		expect(result.text.split("\n")).toEqual(["H", "a", "b"]);
		expect(result.firstChangedLine).toBe(1);
	});

	it("on an empty file", () => {
		const result = applyEdits("", [bof("H")]);
		expect(result.text).toBe("H");
		expect(result.firstChangedLine).toBe(1);
	});
});

describe("INS.TAIL reports the first appended line of the result", () => {
	it("appends after two content lines with no trailing newline in the source", () => {
		const result = applyEdits("a\nb", [eof("T")]);
		expect(result.text.split("\n")).toEqual(["a", "b", "T"]);
		expect(result.firstChangedLine).toBe(3);
	});

	it("a file that is a single line grows to line 2", () => {
		const result = applyEdits("only", [eof("T")]);
		expect(result.text.split("\n")).toEqual(["only", "T"]);
		expect(result.firstChangedLine).toBe(2);
	});
});

describe("HEAD+TAIL in one apply still reports 1 (the earliest change)", () => {
	it("does not let the tail's larger line number win", () => {
		const result = applyEdits("mid", [bof("H"), eof("T")]);
		expect(result.text.split("\n")).toEqual(["H", "mid", "T"]);
		expect(result.firstChangedLine).toBe(1);
	});
});
