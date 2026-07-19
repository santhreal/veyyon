import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	describeAnchorExamples,
	formatDeleteHeader,
	formatHashlineHeader,
	formatInsertHeader,
	formatNumberedLines,
	formatReplaceHeader,
} from "../src/format";

describe("hunk header formatting", () => {
	it("formats SWAP ranges and DEL single/range forms", () => {
		expect(formatReplaceHeader(5, 10)).toBe("SWAP 5.=10:");
		expect(formatDeleteHeader(3)).toBe("DEL 3");
		expect(formatDeleteHeader(3, 3)).toBe("DEL 3");
		expect(formatDeleteHeader(3, 7)).toBe("DEL 3.=7");
	});

	it("formats every INS cursor kind", () => {
		expect(formatInsertHeader({ kind: "before_anchor", anchor: { line: 4 } })).toBe("INS.PRE 4:");
		expect(formatInsertHeader({ kind: "after_anchor", anchor: { line: 4 } })).toBe("INS.POST 4:");
		expect(formatInsertHeader({ kind: "bof" })).toBe("INS.HEAD:");
		expect(formatInsertHeader({ kind: "eof" })).toBe("INS.TAIL:");
	});
});

describe("formatHashlineHeader / formatNumberedLines", () => {
	it("renders the [path#hash] header and numbered lines from a start", () => {
		expect(formatHashlineHeader("src/foo.ts", "1A2B")).toBe("[src/foo.ts#1A2B]");
		expect(formatNumberedLines("a\nb")).toBe("1:a\n2:b");
		expect(formatNumberedLines("a\nb", 10)).toBe("10:a\n11:b");
	});

	it("renders the trailing-newline phantom line as an empty-bodied final number", () => {
		// A newline-terminated file shows one extra numbered line with an empty
		// body. It is the addressable append-past-end anchor (the patcher's
		// trailingPhantomLine), so display stays in lockstep with edit addressing.
		expect(formatNumberedLines("x\ny\n")).toBe("1:x\n2:y\n3:");
		// A file with no trailing newline has no phantom line.
		expect(formatNumberedLines("x\ny")).toBe("1:x\n2:y");
	});
});

describe("computeFileHash", () => {
	it("is a 4-hex uppercase tag, stable across trailing-space and CRLF variants", () => {
		const tag = computeFileHash("line one\nline two\n");
		expect(tag).toMatch(/^[0-9A-F]{4}$/);
		expect(computeFileHash("line one  \nline two\t\n")).toBe(tag);
		expect(computeFileHash("line one\r\nline two\r\n")).toBe(tag);
		expect(computeFileHash("line one\nline two changed\n")).not.toBe(tag);
	});
});

describe("describeAnchorExamples", () => {
	it("quotes defaults and derives examples from a supplied prefix", () => {
		expect(describeAnchorExamples()).toBe('"160", "42", "7"');
		expect(describeAnchorExamples("16")).toBe('"16", "12", "7"');
		expect(describeAnchorExamples("5")).toBe('"5", "42", "7"');
	});
});
