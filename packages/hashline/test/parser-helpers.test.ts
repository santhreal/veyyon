import { describe, expect, it } from "bun:test";
import {
	BARE_LITERAL_VALUE_RE,
	detectApplyPatchContamination,
	expandRange,
	isSkippableCommentLine,
	validateRangeOrder,
} from "../src/parser-helpers";
import type { ParsedRange } from "../src/tokenizer";

describe("validateRangeOrder", () => {
	it("does not throw when start equals end", () => {
		const range: ParsedRange = { start: { line: 5 }, end: { line: 5 } };
		expect(() => validateRangeOrder(range, 1)).not.toThrow();
	});

	it("does not throw when start is before end", () => {
		const range: ParsedRange = { start: { line: 3 }, end: { line: 7 } };
		expect(() => validateRangeOrder(range, 1)).not.toThrow();
	});

	it("throws when end is before start", () => {
		const range: ParsedRange = { start: { line: 7 }, end: { line: 3 } };
		expect(() => validateRangeOrder(range, 10)).toThrow("ends before it starts");
	});

	it("includes line number in error", () => {
		const range: ParsedRange = { start: { line: 10 }, end: { line: 5 } };
		expect(() => validateRangeOrder(range, 42)).toThrow("line 42");
	});
});

describe("expandRange", () => {
	it("expands a single-line range", () => {
		const range: ParsedRange = { start: { line: 5 }, end: { line: 5 } };
		expect(expandRange(range)).toEqual([{ line: 5 }]);
	});

	it("expands a multi-line range", () => {
		const range: ParsedRange = { start: { line: 3 }, end: { line: 6 } };
		expect(expandRange(range)).toEqual([{ line: 3 }, { line: 4 }, { line: 5 }, { line: 6 }]);
	});

	it("expands a large range", () => {
		const range: ParsedRange = { start: { line: 1 }, end: { line: 10 } };
		expect(expandRange(range)).toHaveLength(10);
		expect(expandRange(range)[0]).toEqual({ line: 1 });
		expect(expandRange(range)[9]).toEqual({ line: 10 });
	});
});

describe("isSkippableCommentLine", () => {
	it("returns true for hash comment", () => {
		expect(isSkippableCommentLine("# comment")).toBe(true);
	});

	it("returns true for hash comment with leading whitespace", () => {
		expect(isSkippableCommentLine("  # indented comment")).toBe(true);
	});

	it("returns true for hash comment with tabs", () => {
		expect(isSkippableCommentLine("\t# tabbed comment")).toBe(true);
	});

	it("returns false for non-comment line", () => {
		expect(isSkippableCommentLine("const x = 1;")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isSkippableCommentLine("")).toBe(false);
	});

	it("returns false for whitespace-only string", () => {
		expect(isSkippableCommentLine("   ")).toBe(false);
	});

	it("returns false for line starting with //", () => {
		expect(isSkippableCommentLine("// js comment")).toBe(false);
	});
});

describe("BARE_LITERAL_VALUE_RE", () => {
	it("matches integer", () => {
		expect(BARE_LITERAL_VALUE_RE.test("42")).toBe(true);
	});

	it("matches negative integer", () => {
		expect(BARE_LITERAL_VALUE_RE.test("-42")).toBe(true);
	});

	it("matches decimal", () => {
		expect(BARE_LITERAL_VALUE_RE.test("3.14")).toBe(true);
	});

	it("matches true", () => {
		expect(BARE_LITERAL_VALUE_RE.test("true")).toBe(true);
	});

	it("matches false", () => {
		expect(BARE_LITERAL_VALUE_RE.test("false")).toBe(true);
	});

	it("matches null", () => {
		expect(BARE_LITERAL_VALUE_RE.test("null")).toBe(true);
	});

	it("matches double-quoted string", () => {
		expect(BARE_LITERAL_VALUE_RE.test('"hello"')).toBe(true);
	});

	it("matches single-quoted string", () => {
		expect(BARE_LITERAL_VALUE_RE.test("'hello'")).toBe(true);
	});

	it("matches with trailing comma", () => {
		expect(BARE_LITERAL_VALUE_RE.test("42,")).toBe(true);
	});

	it("matches with surrounding whitespace", () => {
		expect(BARE_LITERAL_VALUE_RE.test("  42  ")).toBe(true);
	});

	it("does not match bare word", () => {
		expect(BARE_LITERAL_VALUE_RE.test("hello")).toBe(false);
	});

	it("does not match object", () => {
		expect(BARE_LITERAL_VALUE_RE.test("{ key: 1 }")).toBe(false);
	});

	it("does not match array", () => {
		expect(BARE_LITERAL_VALUE_RE.test("[1, 2]")).toBe(false);
	});
});

describe("detectApplyPatchContamination", () => {
	it("returns null for empty text", () => {
		expect(detectApplyPatchContamination("", false)).toBeNull();
	});

	it("returns null for whitespace-only text", () => {
		expect(detectApplyPatchContamination("   ", false)).toBeNull();
	});

	it("returns null for valid hashline content", () => {
		expect(detectApplyPatchContamination("SWAP 1.=3:", false)).toBeNull();
	});

	it("detects Update File sentinel", () => {
		const result = detectApplyPatchContamination("*** Update File: src/foo.ts", false);
		expect(result).toContain("apply_patch sentinel");
		expect(result).toContain("not valid in hashline");
	});

	it("detects Add File sentinel", () => {
		const result = detectApplyPatchContamination("*** Add File: src/foo.ts", false);
		expect(result).toContain("apply_patch sentinel");
	});

	it("detects Delete File sentinel", () => {
		const result = detectApplyPatchContamination("*** Delete File: src/foo.ts", false);
		expect(result).toContain("apply_patch sentinel");
	});

	it("detects Move to sentinel", () => {
		const result = detectApplyPatchContamination("*** Move to: src/bar.ts", false);
		expect(result).toContain("apply_patch sentinel");
	});

	it("detects unified-diff hunk header", () => {
		const result = detectApplyPatchContamination("@@ -1,5 +1,5 @@", false);
		expect(result).toContain("unified-diff hunk header");
	});

	it("detects bare @@ brackets", () => {
		const result = detectApplyPatchContamination("@@ some content", false);
		expect(result).toContain("@@");
		expect(result).toContain("not valid in hashline");
	});

	it("detects DEL with colon", () => {
		const result = detectApplyPatchContamination("DEL 5: some text", false);
		expect(result).toContain("DEL");
		expect(result).toContain("no colon");
	});

	it("detects bare line number", () => {
		const result = detectApplyPatchContamination("42", false);
		expect(result).toContain("hunk headers need a verb");
	});

	it("detects bare range with separator", () => {
		const result = detectApplyPatchContamination("3..7:", false);
		expect(result).toContain("bare range hunk header");
	});

	it("detects bare range with dash separator", () => {
		const result = detectApplyPatchContamination("3-7", false);
		expect(result).toContain("bare range hunk header");
	});

	it("truncates long previews", () => {
		const longSentinel = `*** Update File: ${"a".repeat(100)}`;
		const result = detectApplyPatchContamination(longSentinel, false);
		expect(result).toContain("…");
	});

	it("returns null for normal code line", () => {
		expect(detectApplyPatchContamination("const x = 42;", false)).toBeNull();
	});
});
