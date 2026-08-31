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
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_INSERT_AFTER,
	HL_INSERT_AFTER_BLOCK_KEYWORD,
	HL_INSERT_BEFORE,
	HL_INSERT_HEAD,
	HL_INSERT_KEYWORD,
	HL_INSERT_TAIL,
	HL_LINE_BODY_SEP,
	HL_MOVE_KEYWORD,
	HL_RANGE_SEP,
	HL_REM_KEYWORD,
	HL_REPLACE_BLOCK_KEYWORD,
	HL_REPLACE_KEYWORD,
} from "../src/format";
import type { Cursor } from "../src/types";

describe("format constants", () => {
	it("HL_FILE_PREFIX is '['", () => {
		expect(HL_FILE_PREFIX).toBe("[");
	});
	it("HL_FILE_SUFFIX is ']'", () => {
		expect(HL_FILE_SUFFIX).toBe("]");
	});
	it("HL_REPLACE_KEYWORD is 'SWAP'", () => {
		expect(HL_REPLACE_KEYWORD).toBe("SWAP");
	});
	it("HL_DELETE_KEYWORD is 'DEL'", () => {
		expect(HL_DELETE_KEYWORD).toBe("DEL");
	});
	it("HL_INSERT_KEYWORD is 'INS'", () => {
		expect(HL_INSERT_KEYWORD).toBe("INS");
	});
	it("HL_REM_KEYWORD is 'REM'", () => {
		expect(HL_REM_KEYWORD).toBe("REM");
	});
	it("HL_MOVE_KEYWORD is 'MV'", () => {
		expect(HL_MOVE_KEYWORD).toBe("MV");
	});
	it("HL_RANGE_SEP is '.='", () => {
		expect(HL_RANGE_SEP).toBe(".=");
	});
	it("HL_LINE_BODY_SEP is ':'", () => {
		expect(HL_LINE_BODY_SEP).toBe(":");
	});
	it("HL_FILE_HASH_LENGTH is 4", () => {
		expect(HL_FILE_HASH_LENGTH).toBe(4);
	});
});

describe("formatReplaceHeader", () => {
	it("formats single line replace", () => {
		expect(formatReplaceHeader(5, 5)).toBe("SWAP 5.=5:");
	});
	it("formats multi-line replace", () => {
		expect(formatReplaceHeader(10, 20)).toBe("SWAP 10.=20:");
	});
});

describe("formatDeleteHeader", () => {
	it("formats single line delete", () => {
		expect(formatDeleteHeader(5)).toBe("DEL 5");
	});
	it("formats multi-line delete with explicit end", () => {
		expect(formatDeleteHeader(10, 20)).toBe("DEL 10.=20");
	});
	it("formats single line delete with explicit end same as start", () => {
		expect(formatDeleteHeader(5, 5)).toBe("DEL 5");
	});
});

describe("formatInsertHeader", () => {
	it("formats before_anchor insert", () => {
		const cursor: Cursor = { kind: "before_anchor", anchor: { line: 10 } };
		expect(formatInsertHeader(cursor)).toBe("INS.PRE 10:");
	});
	it("formats after_anchor insert", () => {
		const cursor: Cursor = { kind: "after_anchor", anchor: { line: 10 } };
		expect(formatInsertHeader(cursor)).toBe("INS.POST 10:");
	});
	it("formats bof insert", () => {
		const cursor: Cursor = { kind: "bof" };
		expect(formatInsertHeader(cursor)).toBe("INS.HEAD:");
	});
	it("formats eof insert", () => {
		const cursor: Cursor = { kind: "eof" };
		expect(formatInsertHeader(cursor)).toBe("INS.TAIL:");
	});
});

describe("formatHashlineHeader", () => {
	it("formats header with file path and hash", () => {
		expect(formatHashlineHeader("src/foo.ts", "1A2B")).toBe("[src/foo.ts#1A2B]");
	});
});

describe("formatNumberedLine", () => {
	it("formats line with number", () => {
		expect(formatNumberedLine(5, "hello")).toBe("5:hello");
	});
	it("formats line with number 1", () => {
		expect(formatNumberedLine(1, "world")).toBe("1:world");
	});
});

describe("formatNumberedLines", () => {
	it("formats multiple lines starting at 1", () => {
		expect(formatNumberedLines("hello\nworld")).toBe("1:hello\n2:world");
	});
	it("formats multiple lines with custom start", () => {
		expect(formatNumberedLines("hello\nworld", 10)).toBe("10:hello\n11:world");
	});
	it("formats single line", () => {
		expect(formatNumberedLines("hello")).toBe("1:hello");
	});
	it("formats empty string", () => {
		expect(formatNumberedLines("")).toBe("1:");
	});
});

describe("computeFileHash", () => {
	it("returns 4-character uppercase hex string", () => {
		const hash = computeFileHash("hello world");
		expect(hash).toMatch(/^[0-9A-F]{4}$/);
	});
	it("returns same hash for same content", () => {
		expect(computeFileHash("hello")).toBe(computeFileHash("hello"));
	});
	it("returns different hash for different content", () => {
		expect(computeFileHash("hello")).not.toBe(computeFileHash("world"));
	});
	it("normalizes trailing whitespace before hashing", () => {
		const hash1 = computeFileHash("hello\n  \n");
		const hash2 = computeFileHash("hello\n\n");
		expect(hash1).toBe(hash2);
	});
	it("returns consistent hash for empty string", () => {
		const hash = computeFileHash("");
		expect(hash).toMatch(/^[0-9A-F]{4}$/);
	});
});

describe("describeAnchorExamples", () => {
	it("returns default examples without prefix", () => {
		const result = describeAnchorExamples();
		expect(result).toContain('"160"');
		expect(result).toContain('"42"');
		expect(result).toContain('"7"');
	});
	it("returns examples with prefix", () => {
		const result = describeAnchorExamples("40:");
		expect(result).toContain('"40:"');
	});
});

describe("HL_FILE_HASH_RE_RAW", () => {
	it("matches 4 hex characters", () => {
		const re = new RegExp(HL_FILE_HASH_RE_RAW);
		expect(re.test("1A2B")).toBe(true);
		expect(re.test("FFFF")).toBe(true);
		expect(re.test("1234")).toBe(true);
	});
	it("does not match less than 4 characters", () => {
		const re = new RegExp(HL_FILE_HASH_RE_RAW);
		expect(re.test("1A2")).toBe(false);
	});
	it("does not match lowercase", () => {
		const re = new RegExp(HL_FILE_HASH_RE_RAW);
		expect(re.test("1a2b")).toBe(false);
	});
});

describe("block keywords", () => {
	it("HL_REPLACE_BLOCK_KEYWORD is 'SWAP.BLK'", () => {
		expect(HL_REPLACE_BLOCK_KEYWORD).toBe("SWAP.BLK");
	});
	it("HL_INSERT_AFTER_BLOCK_KEYWORD is 'INS.BLK.POST'", () => {
		expect(HL_INSERT_AFTER_BLOCK_KEYWORD).toBe("INS.BLK.POST");
	});
});

describe("insert position keywords", () => {
	it("HL_INSERT_BEFORE is 'PRE'", () => {
		expect(HL_INSERT_BEFORE).toBe("PRE");
	});
	it("HL_INSERT_AFTER is 'POST'", () => {
		expect(HL_INSERT_AFTER).toBe("POST");
	});
	it("HL_INSERT_HEAD is 'HEAD'", () => {
		expect(HL_INSERT_HEAD).toBe("HEAD");
	});
	it("HL_INSERT_TAIL is 'TAIL'", () => {
		expect(HL_INSERT_TAIL).toBe("TAIL");
	});
});
