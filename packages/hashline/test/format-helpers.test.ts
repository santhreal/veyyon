import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	describeAnchorExamples,
	formatDeleteHeader,
	formatHashlineHeader,
	formatInsertHeader,
	formatNumberedLine,
	formatNumberedLines,
	formatReplaceHeader,
	HL_DELETE_KEYWORD,
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_RE_RAW,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_INSERT_AFTER,
	HL_INSERT_BEFORE,
	HL_INSERT_HEAD,
	HL_INSERT_KEYWORD,
	HL_INSERT_TAIL,
	HL_LINE_BODY_SEP,
	HL_RANGE_SEP,
	HL_REPLACE_KEYWORD,
} from "../src/format";
import type { Cursor } from "../src/types";

describe("formatReplaceHeader", () => {
	it("formats single-line replace", () => {
		expect(formatReplaceHeader(5, 5)).toBe(`SWAP 5.=5:`);
	});

	it("formats multi-line replace", () => {
		expect(formatReplaceHeader(10, 20)).toBe(`SWAP 10.=20:`);
	});

	it("formats line 1 replace", () => {
		expect(formatReplaceHeader(1, 1)).toBe(`SWAP 1.=1:`);
	});
});

describe("formatDeleteHeader", () => {
	it("formats single-line delete (default end)", () => {
		expect(formatDeleteHeader(5)).toBe(`DEL 5`);
	});

	it("formats explicit single-line delete", () => {
		expect(formatDeleteHeader(5, 5)).toBe(`DEL 5`);
	});

	it("formats multi-line delete", () => {
		expect(formatDeleteHeader(10, 20)).toBe(`DEL 10.=20`);
	});
});

describe("formatInsertHeader", () => {
	it("formats before_anchor insert", () => {
		const cursor: Cursor = { kind: "before_anchor", anchor: { line: 10 } };
		expect(formatInsertHeader(cursor)).toBe(`INS.PRE 10:`);
	});

	it("formats after_anchor insert", () => {
		const cursor: Cursor = { kind: "after_anchor", anchor: { line: 20 } };
		expect(formatInsertHeader(cursor)).toBe(`INS.POST 20:`);
	});

	it("formats bof insert", () => {
		const cursor: Cursor = { kind: "bof" };
		expect(formatInsertHeader(cursor)).toBe(`INS.HEAD:`);
	});

	it("formats eof insert", () => {
		const cursor: Cursor = { kind: "eof" };
		expect(formatInsertHeader(cursor)).toBe(`INS.TAIL:`);
	});
});

describe("computeFileHash", () => {
	it("returns 4-character uppercase hex string", () => {
		const hash = computeFileHash("hello world");
		expect(hash.length).toBe(HL_FILE_HASH_LENGTH);
		expect(hash).toMatch(/^[0-9A-F]{4}$/);
	});

	it("is deterministic for same input", () => {
		expect(computeFileHash("test")).toBe(computeFileHash("test"));
	});

	it("returns different hashes for different inputs", () => {
		expect(computeFileHash("hello")).not.toBe(computeFileHash("world"));
	});

	it("handles empty string", () => {
		const hash = computeFileHash("");
		expect(hash).toMatch(/^[0-9A-F]{4}$/);
	});

	it("normalizes trailing whitespace before hashing", () => {
		const a = computeFileHash("line1\nline2");
		const b = computeFileHash("line1\nline2   \n");
		// trailing spaces/tabs before newline are stripped, so these should differ
		// because the second has an extra newline
		expect(a).not.toBe(b);
	});

	it("strips trailing spaces before newline (same hash)", () => {
		const a = computeFileHash("line1\nline2");
		const b = computeFileHash("line1   \nline2");
		expect(a).toBe(b);
	});

	it("strips trailing tabs before newline (same hash)", () => {
		const a = computeFileHash("line1\nline2");
		const b = computeFileHash("line1\t\t\nline2");
		expect(a).toBe(b);
	});
});

describe("describeAnchorExamples", () => {
	it("returns default examples when no prefix", () => {
		const result = describeAnchorExamples();
		expect(result).toContain('"160"');
		expect(result).toContain('"42"');
		expect(result).toContain('"7"');
	});

	it("returns prefix-based examples when prefix provided", () => {
		const result = describeAnchorExamples("42");
		expect(result).toContain('"42"');
	});

	it("returns comma-separated quoted examples", () => {
		const result = describeAnchorExamples();
		expect(result).toContain(", ");
	});
});

describe("formatHashlineHeader", () => {
	it("formats header with file path and hash", () => {
		expect(formatHashlineHeader("src/foo.ts", "1A2B")).toBe("[src/foo.ts#1A2B]");
	});

	it("uses # as separator", () => {
		const result = formatHashlineHeader("path", "ABCD");
		expect(result).toContain("#");
	});

	it("wraps in brackets", () => {
		const result = formatHashlineHeader("path", "ABCD");
		expect(result.startsWith("[")).toBe(true);
		expect(result.endsWith("]")).toBe(true);
	});
});

describe("formatNumberedLine", () => {
	it("formats line with number and content", () => {
		expect(formatNumberedLine(5, "hello")).toBe("5:hello");
	});

	it("formats line 1", () => {
		expect(formatNumberedLine(1, "first")).toBe("1:first");
	});

	it("formats empty line content", () => {
		expect(formatNumberedLine(3, "")).toBe("3:");
	});

	it("formats large line numbers", () => {
		expect(formatNumberedLine(1000, "content")).toBe("1000:content");
	});
});

describe("formatNumberedLines", () => {
	it("formats single line starting at 1", () => {
		expect(formatNumberedLines("hello")).toBe("1:hello");
	});

	it("formats multiple lines starting at 1", () => {
		expect(formatNumberedLines("a\nb\nc")).toBe("1:a\n2:b\n3:c");
	});

	it("formats with custom start line", () => {
		expect(formatNumberedLines("a\nb", 10)).toBe("10:a\n11:b");
	});

	it("formats empty string as line 1", () => {
		expect(formatNumberedLines("")).toBe("1:");
	});

	it("formats string with trailing newline", () => {
		// "a\n" splits to ["a", ""]
		expect(formatNumberedLines("a\n")).toBe("1:a\n2:");
	});
});

describe("HL constants", () => {
	it("HL_FILE_PREFIX is [", () => {
		expect(HL_FILE_PREFIX).toBe("[");
	});

	it("HL_FILE_SUFFIX is ]", () => {
		expect(HL_FILE_SUFFIX).toBe("]");
	});

	it("HL_FILE_HASH_SEP is #", () => {
		expect(HL_FILE_HASH_SEP).toBe("#");
	});

	it("HL_FILE_HASH_LENGTH is 4", () => {
		expect(HL_FILE_HASH_LENGTH).toBe(4);
	});

	it("HL_FILE_HASH_RE_RAW matches 4 hex chars", () => {
		expect(HL_FILE_HASH_RE_RAW).toBe("[0-9A-F]{4}");
	});

	it("HL_RANGE_SEP is .=", () => {
		expect(HL_RANGE_SEP).toBe(".=");
	});

	it("HL_LINE_BODY_SEP is :", () => {
		expect(HL_LINE_BODY_SEP).toBe(":");
	});

	it("HL_REPLACE_KEYWORD is SWAP", () => {
		expect(HL_REPLACE_KEYWORD).toBe("SWAP");
	});

	it("HL_DELETE_KEYWORD is DEL", () => {
		expect(HL_DELETE_KEYWORD).toBe("DEL");
	});

	it("HL_INSERT_KEYWORD is INS", () => {
		expect(HL_INSERT_KEYWORD).toBe("INS");
	});

	it("HL_INSERT_BEFORE is PRE", () => {
		expect(HL_INSERT_BEFORE).toBe("PRE");
	});

	it("HL_INSERT_AFTER is POST", () => {
		expect(HL_INSERT_AFTER).toBe("POST");
	});

	it("HL_INSERT_HEAD is HEAD", () => {
		expect(HL_INSERT_HEAD).toBe("HEAD");
	});

	it("HL_INSERT_TAIL is TAIL", () => {
		expect(HL_INSERT_TAIL).toBe("TAIL");
	});
});
