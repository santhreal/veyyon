import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatDeleteHeader,
	formatHashlineHeader,
	formatNumberedLine,
	formatNumberedLines,
	formatReplaceHeader,
	HL_DELETE_BLOCK_KEYWORD,
	HL_DELETE_KEYWORD,
	HL_FILE_HASH_EXAMPLES,
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_HEADER_COLON,
	HL_INSERT_AFTER,
	HL_INSERT_AFTER_BLOCK_KEYWORD,
	HL_INSERT_BEFORE,
	HL_INSERT_HEAD,
	HL_INSERT_KEYWORD,
	HL_INSERT_TAIL,
	HL_LINE_BODY_SEP,
	HL_MOVE_KEYWORD,
	HL_PAYLOAD_REPLACE,
	HL_RANGE_SEP,
	HL_REM_KEYWORD,
	HL_REPLACE_BLOCK_KEYWORD,
	HL_REPLACE_KEYWORD,
} from "../src/format";
import { detectLineEnding, hasUtf8Bom, normalizeToLF, restoreLineEndings, stripBom } from "../src/normalize";

describe("detectLineEnding", () => {
	it("returns LF for LF-only text", () => {
		expect(detectLineEnding("hello\nworld")).toBe("\n");
	});
	it("returns CRLF when CRLF appears first", () => {
		expect(detectLineEnding("hello\r\nworld")).toBe("\r\n");
	});
	it("returns LF when LF appears before CRLF", () => {
		expect(detectLineEnding("hello\nworld\r\n")).toBe("\n");
	});
	it("returns CRLF when CRLF appears before LF", () => {
		expect(detectLineEnding("hello\r\nworld\n")).toBe("\r\n");
	});
	it("returns LF for no line endings", () => {
		expect(detectLineEnding("hello")).toBe("\n");
	});
	it("returns LF for empty string", () => {
		expect(detectLineEnding("")).toBe("\n");
	});
});

describe("normalizeToLF", () => {
	it("converts CRLF to LF", () => {
		expect(normalizeToLF("hello\r\nworld")).toBe("hello\nworld");
	});
	it("converts bare CR to LF", () => {
		expect(normalizeToLF("hello\rworld")).toBe("hello\nworld");
	});
	it("preserves LF", () => {
		expect(normalizeToLF("hello\nworld")).toBe("hello\nworld");
	});
	it("handles mixed line endings", () => {
		expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});
	it("handles empty string", () => {
		expect(normalizeToLF("")).toBe("");
	});
});

describe("restoreLineEndings", () => {
	it("restores CRLF", () => {
		expect(restoreLineEndings("hello\nworld", "\r\n")).toBe("hello\r\nworld");
	});
	it("preserves LF", () => {
		expect(restoreLineEndings("hello\nworld", "\n")).toBe("hello\nworld");
	});
	it("round-trips through normalizeToLF", () => {
		const original = "hello\r\nworld\r\n";
		const normalized = normalizeToLF(original);
		const restored = restoreLineEndings(normalized, "\r\n");
		expect(restored).toBe(original);
	});
});

describe("stripBom", () => {
	it("strips UTF-8 BOM", () => {
		const result = stripBom("\uFEFFhello");
		expect(result.bom).toBe("\uFEFF");
		expect(result.text).toBe("hello");
	});
	it("returns empty bom when no BOM", () => {
		const result = stripBom("hello");
		expect(result.bom).toBe("");
		expect(result.text).toBe("hello");
	});
	it("handles empty string", () => {
		const result = stripBom("");
		expect(result.bom).toBe("");
		expect(result.text).toBe("");
	});
	it("only strips leading BOM", () => {
		const result = stripBom("hello\uFEFF");
		expect(result.bom).toBe("");
		expect(result.text).toBe("hello\uFEFF");
	});
});

describe("hasUtf8Bom", () => {
	it("returns true for bytes starting with EF BB BF", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0xbf, 0x68]))).toBe(true);
	});
	it("returns false for bytes without BOM", () => {
		expect(hasUtf8Bom(new Uint8Array([0x68, 0x65, 0x6c]))).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(hasUtf8Bom(undefined)).toBe(false);
	});
	it("returns false for empty array", () => {
		expect(hasUtf8Bom(new Uint8Array(0))).toBe(false);
	});
	it("returns false for short array", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb]))).toBe(false);
	});
});

describe("format constants", () => {
	it("HL_FILE_PREFIX is [", () => {
		expect(HL_FILE_PREFIX).toBe("[");
	});
	it("HL_FILE_SUFFIX is ]", () => {
		expect(HL_FILE_SUFFIX).toBe("]");
	});
	it("HL_PAYLOAD_REPLACE is +", () => {
		expect(HL_PAYLOAD_REPLACE).toBe("+");
	});
	it("keywords are correct", () => {
		expect(HL_REPLACE_KEYWORD).toBe("SWAP");
		expect(HL_DELETE_KEYWORD).toBe("DEL");
		expect(HL_INSERT_KEYWORD).toBe("INS");
		expect(HL_INSERT_BEFORE).toBe("PRE");
		expect(HL_INSERT_AFTER).toBe("POST");
		expect(HL_INSERT_HEAD).toBe("HEAD");
		expect(HL_INSERT_TAIL).toBe("TAIL");
	});
	it("block keywords are correct", () => {
		expect(HL_REPLACE_BLOCK_KEYWORD).toBe("SWAP.BLK");
		expect(HL_DELETE_BLOCK_KEYWORD).toBe("DEL.BLK");
		expect(HL_INSERT_AFTER_BLOCK_KEYWORD).toBe("INS.BLK.POST");
	});
	it("file keywords are correct", () => {
		expect(HL_REM_KEYWORD).toBe("REM");
		expect(HL_MOVE_KEYWORD).toBe("MV");
	});
	it("separators are correct", () => {
		expect(HL_HEADER_COLON).toBe(":");
		expect(HL_FILE_HASH_SEP).toBe("#");
		expect(HL_RANGE_SEP).toBe(".=");
		expect(HL_LINE_BODY_SEP).toBe(":");
	});
	it("HL_FILE_HASH_LENGTH is 4", () => {
		expect(HL_FILE_HASH_LENGTH).toBe(4);
	});
	it("HL_FILE_HASH_EXAMPLES has 3 examples", () => {
		expect(HL_FILE_HASH_EXAMPLES.length).toBe(3);
	});
});

describe("formatReplaceHeader", () => {
	it("formats SWAP header with range", () => {
		expect(formatReplaceHeader(5, 10)).toBe("SWAP 5.=10:");
	});
	it("formats single-line SWAP", () => {
		expect(formatReplaceHeader(3, 3)).toBe("SWAP 3.=3:");
	});
});

describe("formatDeleteHeader", () => {
	it("formats single-line DEL", () => {
		expect(formatDeleteHeader(5)).toBe("DEL 5");
	});
	it("formats range DEL", () => {
		expect(formatDeleteHeader(5, 10)).toBe("DEL 5.=10");
	});
	it("defaults end to start", () => {
		expect(formatDeleteHeader(7, 7)).toBe("DEL 7");
	});
});

describe("formatHashlineHeader", () => {
	it("formats header with path and hash", () => {
		expect(formatHashlineHeader("src/foo.ts", "1A2B")).toBe("[src/foo.ts#1A2B]");
	});
	it("handles paths with spaces", () => {
		expect(formatHashlineHeader("my file.ts", "ABCD")).toBe("[my file.ts#ABCD]");
	});
});

describe("formatNumberedLine", () => {
	it("formats line with number", () => {
		expect(formatNumberedLine(5, "hello")).toBe("5:hello");
	});
	it("formats line 1", () => {
		expect(formatNumberedLine(1, "world")).toBe("1:world");
	});
});

describe("formatNumberedLines", () => {
	it("formats multiple lines starting at 1", () => {
		expect(formatNumberedLines("hello\nworld")).toBe("1:hello\n2:world");
	});
	it("formats with custom start line", () => {
		expect(formatNumberedLines("hello\nworld", 10)).toBe("10:hello\n11:world");
	});
	it("handles single line", () => {
		expect(formatNumberedLines("hello")).toBe("1:hello");
	});
	it("handles empty string", () => {
		expect(formatNumberedLines("")).toBe("1:");
	});
});

describe("computeFileHash", () => {
	it("returns 4-char hex string", () => {
		const hash = computeFileHash("hello world");
		expect(hash).toMatch(/^[0-9A-F]{4}$/);
	});
	it("is deterministic", () => {
		expect(computeFileHash("hello")).toBe(computeFileHash("hello"));
	});
	it("returns different hashes for different content", () => {
		expect(computeFileHash("hello")).not.toBe(computeFileHash("world"));
	});
	it("ignores trailing whitespace before newline", () => {
		// normalizeFileHashText trims trailing [ \t\r] before \n
		expect(computeFileHash("hello \nworld")).toBe(computeFileHash("hello\nworld"));
	});
	it("handles empty string", () => {
		expect(computeFileHash("")).toMatch(/^[0-9A-F]{4}$/);
	});
});
