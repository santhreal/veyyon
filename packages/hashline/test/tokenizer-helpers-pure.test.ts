import { describe, expect, it } from "bun:test";
import { computeFileHash, formatHashlineHeader } from "../src/format";
import { ABORT_MARKER, BEGIN_PATCH_MARKER, END_PATCH_MARKER } from "../src/messages";
import {
	CHAR_CARRIAGE_RETURN,
	CHAR_COLON,
	CHAR_DOT,
	CHAR_ELLIPSIS,
	CHAR_EQUALS,
	CHAR_HASH,
	CHAR_HYPHEN,
	CHAR_LINE_FEED,
	CHAR_NINE,
	CHAR_PAYLOAD_REPLACE,
	CHAR_ZERO,
	classifyLine,
	cloneCursor,
	markerLineEquals,
	parseLid,
	scanKeyword,
	skipWhitespace,
	splitHashlineLines,
	tryParseHeader,
	tryParseHunkHeader,
} from "../src/tokenizer-helpers";

describe("char constants", () => {
	it("CHAR_LINE_FEED is 10", () => {
		expect(CHAR_LINE_FEED).toBe(10);
	});
	it("CHAR_CARRIAGE_RETURN is 13", () => {
		expect(CHAR_CARRIAGE_RETURN).toBe(13);
	});
	it("CHAR_ZERO is 48", () => {
		expect(CHAR_ZERO).toBe(48);
	});
	it("CHAR_NINE is 57", () => {
		expect(CHAR_NINE).toBe(57);
	});
	it("CHAR_HASH is 35", () => {
		expect(CHAR_HASH).toBe(35);
	});
	it("CHAR_DOT is 46", () => {
		expect(CHAR_DOT).toBe(46);
	});
	it("CHAR_HYPHEN is 45", () => {
		expect(CHAR_HYPHEN).toBe(45);
	});
	it("CHAR_EQUALS is 61", () => {
		expect(CHAR_EQUALS).toBe(61);
	});
	it("CHAR_COLON is 58 (ASCII colon)", () => {
		expect(CHAR_COLON).toBe(58);
	});
	it("CHAR_PAYLOAD_REPLACE is 43 (plus sign)", () => {
		expect(CHAR_PAYLOAD_REPLACE).toBe(43);
	});
	it("CHAR_ELLIPSIS is 0x2026", () => {
		expect(CHAR_ELLIPSIS).toBe(0x2026);
	});
});

describe("skipWhitespace", () => {
	it("skips leading spaces", () => {
		expect(skipWhitespace("   hello", 0)).toBe(3);
	});
	it("skips leading tabs", () => {
		expect(skipWhitespace("\t\thello", 0)).toBe(2);
	});
	it("returns index when no whitespace", () => {
		expect(skipWhitespace("hello", 0)).toBe(0);
	});
	it("skips mixed whitespace", () => {
		expect(skipWhitespace(" \t \t hello", 0)).toBe(5);
	});
	it("respects end parameter", () => {
		expect(skipWhitespace("  hello", 0, 1)).toBe(1);
	});
	it("returns end when all whitespace up to end", () => {
		expect(skipWhitespace("   ", 0)).toBe(3);
	});
	it("handles empty string", () => {
		expect(skipWhitespace("", 0)).toBe(0);
	});
	it("handles carriage return as whitespace", () => {
		expect(skipWhitespace("\r\rhello", 0)).toBe(2);
	});
});

describe("markerLineEquals", () => {
	it("matches exact marker", () => {
		expect(markerLineEquals("*** Begin Patch", BEGIN_PATCH_MARKER)).toBe(true);
	});
	it("matches marker with trailing whitespace", () => {
		expect(markerLineEquals("*** Begin Patch   ", BEGIN_PATCH_MARKER)).toBe(true);
	});
	it("does not match different text", () => {
		expect(markerLineEquals("hello", BEGIN_PATCH_MARKER)).toBe(false);
	});
	it("does not match prefix only", () => {
		expect(markerLineEquals("*** Begin", BEGIN_PATCH_MARKER)).toBe(false);
	});
	it("matches empty marker on empty line", () => {
		expect(markerLineEquals("", "")).toBe(true);
	});
	it("matches abort marker", () => {
		expect(markerLineEquals("*** Abort", ABORT_MARKER)).toBe(true);
	});
	it("matches end patch marker", () => {
		expect(markerLineEquals("*** End Patch", END_PATCH_MARKER)).toBe(true);
	});
});

describe("splitHashlineLines", () => {
	it("splits on newlines", () => {
		expect(splitHashlineLines("a\nb\nc")).toEqual(["a", "b", "c"]);
	});
	it("strips trailing CR from each line", () => {
		expect(splitHashlineLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
	});
	it("returns [''] for empty string", () => {
		expect(splitHashlineLines("")).toEqual([""]);
	});
	it("handles single line", () => {
		expect(splitHashlineLines("hello")).toEqual(["hello"]);
	});
	it("handles trailing newline without empty last element", () => {
		expect(splitHashlineLines("a\nb\n")).toEqual(["a", "b"]);
	});
	it("handles only newlines", () => {
		expect(splitHashlineLines("\n\n\n")).toEqual(["", "", ""]);
	});
	it("handles CR-only line endings", () => {
		expect(splitHashlineLines("a\rb")).toEqual(["a\rb"]);
	});
	it("handles mixed CR/LF and LF", () => {
		expect(splitHashlineLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
	});
});

describe("cloneCursor", () => {
	it("clones before_anchor cursor", () => {
		const cursor = { kind: "before_anchor" as const, anchor: { line: 5 } };
		const cloned = cloneCursor(cursor);
		expect(cloned).toEqual(cursor);
		expect(cloned).not.toBe(cursor);
		expect((cloned as { anchor: { line: number } }).anchor).not.toBe((cursor as { anchor: { line: number } }).anchor);
	});
	it("clones after_anchor cursor", () => {
		const cursor = { kind: "after_anchor" as const, anchor: { line: 10 } };
		const cloned = cloneCursor(cursor);
		expect(cloned).toEqual(cursor);
		expect(cloned).not.toBe(cursor);
		expect((cloned as { anchor: { line: number } }).anchor).not.toBe((cursor as { anchor: { line: number } }).anchor);
	});
	it("clones bof cursor", () => {
		const cursor = { kind: "bof" as const };
		expect(cloneCursor(cursor)).toEqual(cursor);
	});
	it("clones eof cursor", () => {
		const cursor = { kind: "eof" as const };
		expect(cloneCursor(cursor)).toEqual(cursor);
	});
});

describe("parseLid", () => {
	it("parses plain number", () => {
		expect(parseLid("42", 1)).toEqual({ line: 42 });
	});
	it("parses number with leading whitespace", () => {
		expect(parseLid("  42", 1)).toEqual({ line: 42 });
	});
	it("throws on trailing content after colon", () => {
		expect(() => parseLid("42:hello", 1)).toThrow();
	});
	it("parses number with trailing whitespace", () => {
		expect(parseLid("42  ", 1)).toEqual({ line: 42 });
	});
	it("parses single digit", () => {
		expect(parseLid("7", 1)).toEqual({ line: 7 });
	});
	it("throws on zero", () => {
		expect(() => parseLid("0", 1)).toThrow();
	});
	it("throws on non-numeric", () => {
		expect(() => parseLid("abc", 1)).toThrow();
	});
	it("throws on empty string", () => {
		expect(() => parseLid("", 1)).toThrow();
	});
	it("throws on leading zeros", () => {
		expect(() => parseLid("007", 1)).toThrow();
	});
	it("throws on negative", () => {
		expect(() => parseLid("-5", 1)).toThrow();
	});
});

describe("scanKeyword", () => {
	it("matches keyword at index", () => {
		expect(scanKeyword("SWAP 5:", 0, 6, "SWAP")).toBe(4);
	});
	it("returns null when keyword not present", () => {
		expect(scanKeyword("DEL 5", 0, 5, "SWAP")).toBeNull();
	});
	it("matches keyword followed by colon", () => {
		expect(scanKeyword("INS:5", 0, 5, "INS")).toBe(3);
	});
	it("matches keyword followed by dot", () => {
		expect(scanKeyword("INS.HEAD:", 0, 9, "INS")).toBe(3);
	});
	it("returns null when keyword is followed by alphanumeric", () => {
		expect(scanKeyword("INSERT", 0, 6, "INS")).toBeNull();
	});
	it("matches at end of string", () => {
		expect(scanKeyword("SWAP", 0, 4, "SWAP")).toBe(4);
	});
	it("matches keyword followed by whitespace", () => {
		expect(scanKeyword("SWAP  5", 0, 7, "SWAP")).toBe(4);
	});
});

describe("tryParseHeader", () => {
	it("parses header with hash", () => {
		const result = tryParseHeader("[src/foo.ts#1A2B]");
		expect(result).toEqual({ path: "src/foo.ts", fileHash: "1A2B" });
	});
	it("parses header without hash", () => {
		const result = tryParseHeader("[src/foo.ts]");
		expect(result).toEqual({ path: "src/foo.ts" });
	});
	it("returns null for non-bracket line", () => {
		expect(tryParseHeader("hello")).toBeNull();
	});
	it("returns null for empty brackets", () => {
		expect(tryParseHeader("[]")).toBeNull();
	});
	it("returns null for hash-only brackets", () => {
		expect(tryParseHeader("[#1A2B]")).toBeNull();
	});
	it("uppercases file hash", () => {
		const result = tryParseHeader("[foo.ts#1a2b]");
		expect(result?.fileHash).toBe("1A2B");
	});
	it("handles path with dots", () => {
		expect(tryParseHeader("[foo.bar.baz.ts#ABCD]")?.path).toBe("foo.bar.baz.ts");
	});
	it("returns null for hash in path", () => {
		expect(tryParseHeader("[foo#bar.ts]")).toBeNull();
	});
	it("parses single-char path", () => {
		expect(tryParseHeader("[a#1A2B]")?.path).toBe("a");
	});
	it("handles trailing whitespace", () => {
		expect(tryParseHeader("[foo.ts#1A2B]  ")?.path).toBe("foo.ts");
	});
	it("rejects non-hex trailing hash", () => {
		expect(tryParseHeader("[foo.ts#XYZ1]")?.fileHash).toBeUndefined();
	});
	it("rejects hash shorter than 4 chars", () => {
		expect(tryParseHeader("[foo.ts#1A2]")?.fileHash).toBeUndefined();
	});
});

describe("tryParseHunkHeader", () => {
	it("parses SWAP range", () => {
		const result = tryParseHunkHeader("SWAP 5.=10:");
		expect(result?.target.kind).toBe("replace");
	});
	it("parses SWAP single line", () => {
		const result = tryParseHunkHeader("SWAP 5:");
		expect(result?.target.kind).toBe("replace");
	});
	it("parses DEL range", () => {
		const result = tryParseHunkHeader("DEL 5.=10");
		expect(result?.target.kind).toBe("delete");
	});
	it("parses DEL single line", () => {
		const result = tryParseHunkHeader("DEL 5");
		expect(result?.target.kind).toBe("delete");
	});
	it("parses SWAP.BLK", () => {
		const result = tryParseHunkHeader("SWAP.BLK 5:");
		expect(result?.target.kind).toBe("block");
	});
	it("parses DEL.BLK", () => {
		const result = tryParseHunkHeader("DEL.BLK 5");
		expect(result?.target.kind).toBe("delete_block");
	});
	it("parses INS.PRE", () => {
		const result = tryParseHunkHeader("INS.PRE 5:");
		expect(result?.target.kind).toBe("insert_before");
	});
	it("parses INS.POST", () => {
		const result = tryParseHunkHeader("INS.POST 5:");
		expect(result?.target.kind).toBe("insert_after");
	});
	it("parses INS.HEAD", () => {
		const result = tryParseHunkHeader("INS.HEAD:");
		expect(result?.target.kind).toBe("bof");
	});
	it("parses INS.TAIL", () => {
		const result = tryParseHunkHeader("INS.TAIL:");
		expect(result?.target.kind).toBe("eof");
	});
	it("parses INS.BLK.POST", () => {
		const result = tryParseHunkHeader("INS.BLK.POST 5:");
		expect(result?.target.kind).toBe("insert_after_block");
	});
	it("parses REM", () => {
		const result = tryParseHunkHeader("REM");
		expect(result?.target.kind).toBe("rem");
	});
	it("parses MV", () => {
		const result = tryParseHunkHeader("MV dest.ts");
		expect(result?.target.kind).toBe("move");
	});
	it("parses MV with quoted dest", () => {
		const result = tryParseHunkHeader("MV 'dest file.ts'");
		expect(result?.target.kind).toBe("move");
	});
	it("returns null for empty line", () => {
		expect(tryParseHunkHeader("")).toBeNull();
	});
	it("returns null for whitespace-only line", () => {
		expect(tryParseHunkHeader("   ")).toBeNull();
	});
	it("returns null for unknown keyword", () => {
		expect(tryParseHunkHeader("HELLO 5")).toBeNull();
	});
	it("returns null for DEL with colon (DEL takes no body)", () => {
		expect(tryParseHunkHeader("DEL 5:")).toBeNull();
	});
	it("returns null for DEL.BLK with colon", () => {
		expect(tryParseHunkHeader("DEL.BLK 5:")).toBeNull();
	});
	it("returns null for trailing garbage after hunk", () => {
		expect(tryParseHunkHeader("SWAP 5.: extra")).toBeNull();
	});
	it("parses SWAP with .. separator", () => {
		const result = tryParseHunkHeader("SWAP 5..10:");
		expect(result?.target.kind).toBe("replace");
	});
	it("parses SWAP with … separator", () => {
		const result = tryParseHunkHeader("SWAP 5…10:");
		expect(result?.target.kind).toBe("replace");
	});
	it("parses SWAP with - separator", () => {
		const result = tryParseHunkHeader("SWAP 5-10:");
		expect(result?.target.kind).toBe("replace");
	});
	it("parses REM with trailing whitespace", () => {
		expect(tryParseHunkHeader("REM  ")?.target.kind).toBe("rem");
	});
	it("returns null for REM with trailing text", () => {
		expect(tryParseHunkHeader("REM foo")).toBeNull();
	});
	it("returns null for MV with empty dest", () => {
		expect(tryParseHunkHeader("MV")).toBeNull();
	});
	it("returns null for MV with only whitespace dest", () => {
		expect(tryParseHunkHeader("MV   ")).toBeNull();
	});
});

describe("classifyLine", () => {
	it("classifies blank line", () => {
		expect(classifyLine("", 1).kind).toBe("blank");
	});
	it("classifies envelope begin", () => {
		expect(classifyLine("*** Begin Patch", 1).kind).toBe("envelope-begin");
	});
	it("classifies envelope end", () => {
		expect(classifyLine("*** End Patch", 1).kind).toBe("envelope-end");
	});
	it("classifies abort", () => {
		expect(classifyLine("*** Abort", 1).kind).toBe("abort");
	});
	it("classifies header with hash", () => {
		const token = classifyLine("[foo.ts#1A2B]", 1);
		expect(token.kind).toBe("header");
	});
	it("classifies header without hash", () => {
		const token = classifyLine("[foo.ts]", 1);
		expect(token.kind).toBe("header");
	});
	it("classifies SWAP op-block", () => {
		const token = classifyLine("SWAP 5.=10:", 1);
		expect(token.kind).toBe("op-block");
	});
	it("classifies DEL op-block", () => {
		const token = classifyLine("DEL 5", 1);
		expect(token.kind).toBe("op-block");
	});
	it("classifies INS op-block", () => {
		const token = classifyLine("INS.PRE 5:", 1);
		expect(token.kind).toBe("op-block");
	});
	it("classifies REM op-block", () => {
		const token = classifyLine("REM", 1);
		expect(token.kind).toBe("op-block");
	});
	it("classifies MV op-block", () => {
		const token = classifyLine("MV dest.ts", 1);
		expect(token.kind).toBe("op-block");
	});
	it("classifies payload-literal from + prefix", () => {
		const token = classifyLine("+hello world", 1);
		expect(token.kind).toBe("payload-literal");
	});
	it("classifies raw line", () => {
		const token = classifyLine("hello world", 1);
		expect(token.kind).toBe("raw");
	});
	it("classifies raw for non-keyword line starting with SWAP", () => {
		const token = classifyLine("SWAPfoo", 1);
		expect(token.kind).toBe("raw");
	});
	it("preserves lineNum", () => {
		expect(classifyLine("hello", 42).lineNum).toBe(42);
	});
	it("classifies whitespace-only line as raw (not blank)", () => {
		expect(classifyLine("   ", 1).kind).toBe("raw");
	});
});

describe("computeFileHash integration", () => {
	it("produces 4-char uppercase hex", () => {
		const hash = computeFileHash("hello\nworld\n");
		expect(hash).toMatch(/^[0-9A-F]{4}$/);
	});
	it("is deterministic", () => {
		expect(computeFileHash("hello")).toBe(computeFileHash("hello"));
	});
	it("normalizes trailing whitespace before hashing", () => {
		expect(computeFileHash("hello\n")).toBe(computeFileHash("hello\r\n"));
	});
	it("formatHashlineHeader round-trips with tryParseHeader", () => {
		const hash = computeFileHash("test content");
		const header = formatHashlineHeader("src/test.ts", hash);
		const parsed = tryParseHeader(header);
		expect(parsed).toEqual({ path: "src/test.ts", fileHash: hash });
	});
});
