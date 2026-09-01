import { describe, expect, it } from "bun:test";
import {
	ABORT_MARKER,
	afterInsertLandingShiftWarning,
	ambiguousBoundaryEchoMessage,
	ambiguousCloserSpareMessage,
	BARE_BODY_AUTO_PIPED_WARNING,
	BEGIN_PATCH_MARKER,
	BLOCK_RESOLVER_UNAVAILABLE,
	blockInsertLandingShiftWarning,
	blockSingleLineMessage,
	blockUnresolvedMessage,
	DELETE_BLOCK_TAKES_NO_BODY,
	DELETE_TAKES_NO_BODY,
	EMPTY_BLOCK,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	END_PATCH_MARKER,
	formatAnchoredContext,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	MINUS_ROW_REJECTED,
	MISMATCH_CONTEXT,
	MOVE_TAKES_NO_BODY,
	missingSnapshotTagMessage,
	pathRecoveredFromTagMessage,
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_CHAIN_WARNING,
	REM_TAKES_NO_BODY,
	UNRESOLVED_BLOCK_INTERNAL,
	unseenLinesMessage,
} from "../src/messages";
import { detectLineEnding, hasUtf8Bom, normalizeToLF, restoreLineEndings, stripBom } from "../src/normalize";
import {
	hashlineParseText,
	stripHashlinePrefixes,
	stripNewLinePrefixes,
	stripOneLeadingHashlinePrefix,
} from "../src/prefixes";

describe("detectLineEnding", () => {
	it("detects LF", () => {
		expect(detectLineEnding("line1\nline2")).toBe("\n");
	});

	it("detects CRLF when it appears first", () => {
		expect(detectLineEnding("line1\r\nline2")).toBe("\r\n");
	});

	it("returns LF when no line endings", () => {
		expect(detectLineEnding("single line")).toBe("\n");
	});

	it("returns LF when only LF present", () => {
		expect(detectLineEnding("a\nb\nc")).toBe("\n");
	});

	it("returns CRLF when CRLF appears before LF", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
	});

	it("returns LF when LF appears before CRLF", () => {
		expect(detectLineEnding("a\nb\r\nc")).toBe("\n");
	});

	it("handles empty string", () => {
		expect(detectLineEnding("")).toBe("\n");
	});

	it("handles only CRLF", () => {
		expect(detectLineEnding("\r\n")).toBe("\r\n");
	});
});

describe("normalizeToLF", () => {
	it("converts CRLF to LF", () => {
		expect(normalizeToLF("a\r\nb")).toBe("a\nb");
	});

	it("converts lone CR to LF", () => {
		expect(normalizeToLF("a\rb")).toBe("a\nb");
	});

	it("preserves LF", () => {
		expect(normalizeToLF("a\nb")).toBe("a\nb");
	});

	it("handles mixed line endings", () => {
		expect(normalizeToLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
	});

	it("handles empty string", () => {
		expect(normalizeToLF("")).toBe("");
	});

	it("handles string with no line endings", () => {
		expect(normalizeToLF("hello")).toBe("hello");
	});
});

describe("restoreLineEndings", () => {
	it("restores CRLF", () => {
		expect(restoreLineEndings("a\nb\nc", "\r\n")).toBe("a\r\nb\r\nc");
	});

	it("preserves LF", () => {
		expect(restoreLineEndings("a\nb\nc", "\n")).toBe("a\nb\nc");
	});

	it("handles empty string", () => {
		expect(restoreLineEndings("", "\r\n")).toBe("");
	});

	it("handles string with no newlines", () => {
		expect(restoreLineEndings("hello", "\r\n")).toBe("hello");
	});
});

describe("stripBom", () => {
	it("strips BOM from string starting with BOM", () => {
		const result = stripBom("\uFEFFhello");
		expect(result.bom).toBe("\uFEFF");
		expect(result.text).toBe("hello");
	});

	it("returns empty bom and original text when no BOM", () => {
		const result = stripBom("hello");
		expect(result.bom).toBe("");
		expect(result.text).toBe("hello");
	});

	it("handles empty string", () => {
		const result = stripBom("");
		expect(result.bom).toBe("");
		expect(result.text).toBe("");
	});

	it("handles string that is only BOM", () => {
		const result = stripBom("\uFEFF");
		expect(result.bom).toBe("\uFEFF");
		expect(result.text).toBe("");
	});
});

describe("hasUtf8Bom", () => {
	it("returns true for bytes with UTF-8 BOM", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0xbf, 0x68]))).toBe(true);
	});

	it("returns true for exactly 3 BOM bytes", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe(true);
	});

	it("returns false for bytes without BOM", () => {
		expect(hasUtf8Bom(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]))).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(hasUtf8Bom(undefined)).toBe(false);
	});

	it("returns false for empty array", () => {
		expect(hasUtf8Bom(new Uint8Array([]))).toBe(false);
	});

	it("returns false for short array", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb]))).toBe(false);
	});

	it("returns false for wrong BOM bytes", () => {
		expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb, 0x00]))).toBe(false);
	});
});

describe("stripOneLeadingHashlinePrefix", () => {
	it("strips numbered line prefix", () => {
		expect(stripOneLeadingHashlinePrefix("42:hello")).toBe("hello");
	});

	it("strips prefix with >>> marker", () => {
		expect(stripOneLeadingHashlinePrefix(">>> 42:hello")).toBe("hello");
	});

	it("strips prefix with >> marker", () => {
		expect(stripOneLeadingHashlinePrefix(">> 42:hello")).toBe("hello");
	});

	it("strips prefix with + marker", () => {
		expect(stripOneLeadingHashlinePrefix("+ 42:hello")).toBe("hello");
	});

	it("strips prefix with - marker", () => {
		expect(stripOneLeadingHashlinePrefix("- 42:hello")).toBe("hello");
	});

	it("strips prefix with * marker", () => {
		expect(stripOneLeadingHashlinePrefix("* 42:hello")).toBe("hello");
	});

	it("returns line unchanged when no prefix", () => {
		expect(stripOneLeadingHashlinePrefix("hello")).toBe("hello");
	});

	it("handles empty string", () => {
		expect(stripOneLeadingHashlinePrefix("")).toBe("");
	});
});

describe("hashlineParseText", () => {
	it("returns empty array for null", () => {
		expect(hashlineParseText(null)).toEqual([]);
	});

	it("returns empty array for undefined", () => {
		expect(hashlineParseText(undefined)).toEqual([]);
	});

	it("splits string by newlines", () => {
		expect(hashlineParseText("a\nb\nc")).toEqual(["a", "b", "c"]);
	});

	it("returns array as-is", () => {
		expect(hashlineParseText(["a", "b"])).toEqual(["a", "b"]);
	});

	it("returns [''] for empty string", () => {
		expect(hashlineParseText("")).toEqual([""]);
	});

	it("returns empty array for empty array", () => {
		expect(hashlineParseText([])).toEqual([]);
	});
});

describe("formatAnchoredContext", () => {
	it("formats context lines with line numbers", () => {
		const result = formatAnchoredContext([1, 2], ["line1", "line2"]);
		expect(result.length).toBe(2);
		expect(result[0]).toContain("1");
		expect(result[0]).toContain("line1");
	});

	it("handles empty anchor lines", () => {
		expect(formatAnchoredContext([], ["line1"])).toEqual([]);
	});

	it("handles single line within range", () => {
		const result = formatAnchoredContext([1], ["line1"]);
		expect(result.length).toBe(1);
		expect(result[0]).toContain("1");
		expect(result[0]).toContain("line1");
	});

	it("returns empty when anchor line is out of range", () => {
		expect(formatAnchoredContext([5], ["line1"])).toEqual([]);
	});
});

describe("message constants", () => {
	it("MISMATCH_CONTEXT is 2", () => {
		expect(MISMATCH_CONTEXT).toBe(2);
	});

	it("BEGIN_PATCH_MARKER is correct", () => {
		expect(BEGIN_PATCH_MARKER).toBe("*** Begin Patch");
	});

	it("END_PATCH_MARKER is correct", () => {
		expect(END_PATCH_MARKER).toBe("*** End Patch");
	});

	it("ABORT_MARKER is correct", () => {
		expect(ABORT_MARKER).toBe("*** Abort");
	});

	it("BARE_BODY_AUTO_PIPED_WARNING is non-empty", () => {
		expect(BARE_BODY_AUTO_PIPED_WARNING.length).toBeGreaterThan(0);
	});

	it("MINUS_ROW_REJECTED is non-empty", () => {
		expect(MINUS_ROW_REJECTED.length).toBeGreaterThan(0);
	});

	it("EMPTY_REPLACE contains SWAP", () => {
		expect(EMPTY_REPLACE).toContain("SWAP");
	});

	it("EMPTY_BLOCK contains SWAP.BLK", () => {
		expect(EMPTY_BLOCK).toContain("SWAP.BLK");
	});

	it("DELETE_TAKES_NO_BODY contains DEL", () => {
		expect(DELETE_TAKES_NO_BODY).toContain("DEL");
	});

	it("REM_TAKES_NO_BODY contains REM", () => {
		expect(REM_TAKES_NO_BODY).toContain("REM");
	});

	it("MOVE_TAKES_NO_BODY contains MV", () => {
		expect(MOVE_TAKES_NO_BODY).toContain("MV");
	});

	it("DELETE_BLOCK_TAKES_NO_BODY contains DEL.BLK", () => {
		expect(DELETE_BLOCK_TAKES_NO_BODY).toContain("DEL.BLK");
	});

	it("EMPTY_INSERT contains INS", () => {
		expect(EMPTY_INSERT).toContain("INS");
	});

	it("BLOCK_RESOLVER_UNAVAILABLE contains SWAP.BLK", () => {
		expect(BLOCK_RESOLVER_UNAVAILABLE).toContain("SWAP.BLK");
	});

	it("UNRESOLVED_BLOCK_INTERNAL contains SWAP.BLK", () => {
		expect(UNRESOLVED_BLOCK_INTERNAL).toContain("SWAP.BLK");
	});

	it("RECOVERY warnings are non-empty", () => {
		expect(RECOVERY_EXTERNAL_WARNING.length).toBeGreaterThan(0);
		expect(RECOVERY_SESSION_CHAIN_WARNING.length).toBeGreaterThan(0);
		expect(RECOVERY_LINE_REMAP_WARNING.length).toBeGreaterThan(0);
	});
});

describe("message functions", () => {
	it("blockUnresolvedMessage contains line number", () => {
		const msg = blockUnresolvedMessage(42);
		expect(msg).toContain("42");
	});

	it("blockUnresolvedMessage with delete op", () => {
		const msg = blockUnresolvedMessage(42, "delete");
		expect(msg).toContain("42");
	});

	it("insertAfterBlockCloserLoweredWarning contains line", () => {
		const msg = insertAfterBlockCloserLoweredWarning(10);
		expect(msg).toContain("10");
		expect(msg).toContain("INS.BLK.POST");
	});

	it("insertAfterBlockUnresolvedLoweredWarning contains line", () => {
		const msg = insertAfterBlockUnresolvedLoweredWarning(10);
		expect(msg).toContain("10");
	});

	it("afterInsertLandingShiftWarning contains anchor and landing", () => {
		const msg = afterInsertLandingShiftWarning(5, 8, 2);
		expect(msg).toContain("5");
		expect(msg).toContain("8");
	});

	it("afterInsertLandingShiftWarning singular plural", () => {
		const singular = afterInsertLandingShiftWarning(5, 6, 1);
		const plural = afterInsertLandingShiftWarning(5, 7, 2);
		expect(singular).not.toContain("lines");
		expect(plural).toContain("lines");
	});

	it("blockInsertLandingShiftWarning contains block start and closer", () => {
		const msg = blockInsertLandingShiftWarning(10, 15, 12);
		expect(msg).toContain("10");
		expect(msg).toContain("15");
		expect(msg).toContain("12");
	});

	it("missingSnapshotTagMessage contains path", () => {
		const msg = missingSnapshotTagMessage("src/foo.ts");
		expect(msg).toContain("src/foo.ts");
	});

	it("pathRecoveredFromTagMessage contains paths and tag", () => {
		const msg = pathRecoveredFromTagMessage("authored.ts", "resolved.ts", "ABC1");
		expect(msg).toContain("authored.ts");
		expect(msg).toContain("resolved.ts");
		expect(msg).toContain("ABC1");
	});

	it("blockSingleLineMessage for replace", () => {
		const msg = blockSingleLineMessage(5, "replace");
		expect(msg).toContain("5");
	});

	it("blockSingleLineMessage for delete", () => {
		const msg = blockSingleLineMessage(5, "delete");
		expect(msg).toContain("5");
	});

	it("blockSingleLineMessage for insert_after", () => {
		const msg = blockSingleLineMessage(5, "insert_after");
		expect(msg).toContain("5");
	});

	it("ambiguousBoundaryEchoMessage contains start and end", () => {
		const msg = ambiguousBoundaryEchoMessage(1, 5, "leading", 2);
		expect(msg).toContain("1");
		expect(msg).toContain("5");
	});

	it("ambiguousCloserSpareMessage contains lines", () => {
		const msg = ambiguousCloserSpareMessage(1, 5, 3, 2);
		expect(msg).toContain("1");
		expect(msg).toContain("5");
	});

	it("unseenLinesMessage contains path and tag", () => {
		const msg = unseenLinesMessage("src/foo.ts", [1, 2, 3], "ABC1");
		expect(msg).toContain("src/foo.ts");
		expect(msg).toContain("ABC1");
	});
});

describe("stripNewLinePrefixes", () => {
	it("returns lines unchanged when all empty", () => {
		expect(stripNewLinePrefixes(["", "", ""])).toEqual(["", "", ""]);
	});

	it("returns lines unchanged when no prefixes", () => {
		expect(stripNewLinePrefixes(["hello", "world"])).toEqual(["hello", "world"]);
	});

	it("strips hashline prefixes when all content lines have them", () => {
		const lines = ["[file.ts#ABCD]", "1:hello", "2:world"];
		const result = stripNewLinePrefixes(lines);
		expect(result).toContain("hello");
		expect(result).toContain("world");
	});
});

describe("stripHashlinePrefixes", () => {
	it("strips prefixes from lines", () => {
		const result = stripHashlinePrefixes(["1:hello", "2:world"]);
		expect(result).toEqual(["hello", "world"]);
	});

	it("returns lines without prefixes unchanged", () => {
		expect(stripHashlinePrefixes(["hello", "world"])).toEqual(["hello", "world"]);
	});

	it("handles empty array", () => {
		expect(stripHashlinePrefixes([])).toEqual([]);
	});
});
