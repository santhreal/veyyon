import { describe, expect, it } from "bun:test";
import { HL_RANGE_SEP } from "../src/format";
import {
	BARE_LITERAL_VALUE_RE,
	detectApplyPatchContamination,
	expandRange,
	isSkippableCommentLine,
	validateRangeOrder,
} from "../src/parser-helpers";

describe("validateRangeOrder", () => {
	it("does not throw when end >= start", () => {
		expect(() => validateRangeOrder({ start: { line: 5 }, end: { line: 10 } }, 1)).not.toThrow();
	});
	it("does not throw for single-line range", () => {
		expect(() => validateRangeOrder({ start: { line: 5 }, end: { line: 5 } }, 1)).not.toThrow();
	});
	it("throws when end < start", () => {
		expect(() => validateRangeOrder({ start: { line: 10 }, end: { line: 5 } }, 3)).toThrow(
			`line 3: range 10${HL_RANGE_SEP}5 ends before it starts.`,
		);
	});
});

describe("expandRange", () => {
	it("expands single-line range to one anchor", () => {
		expect(expandRange({ start: { line: 5 }, end: { line: 5 } })).toEqual([{ line: 5 }]);
	});
	it("expands multi-line range to anchors", () => {
		expect(expandRange({ start: { line: 3 }, end: { line: 6 } })).toEqual([
			{ line: 3 },
			{ line: 4 },
			{ line: 5 },
			{ line: 6 },
		]);
	});
	it("expands range starting at line 1", () => {
		expect(expandRange({ start: { line: 1 }, end: { line: 3 } })).toEqual([{ line: 1 }, { line: 2 }, { line: 3 }]);
	});
});

describe("isSkippableCommentLine", () => {
	it("returns true for hash comment", () => {
		expect(isSkippableCommentLine("# comment")).toBe(true);
	});
	it("returns true for hash comment with leading whitespace", () => {
		expect(isSkippableCommentLine("   # comment")).toBe(true);
	});
	it("returns true for hash-only line", () => {
		expect(isSkippableCommentLine("#")).toBe(true);
	});
	it("returns false for non-comment line", () => {
		expect(isSkippableCommentLine("hello")).toBe(false);
	});
	it("returns false for empty line", () => {
		expect(isSkippableCommentLine("")).toBe(false);
	});
	it("returns false for line starting with //", () => {
		expect(isSkippableCommentLine("// comment")).toBe(false);
	});
});

describe("BARE_LITERAL_VALUE_RE", () => {
	it("matches double-quoted string", () => {
		expect(BARE_LITERAL_VALUE_RE.test('"hello"')).toBe(true);
	});
	it("matches single-quoted string", () => {
		expect(BARE_LITERAL_VALUE_RE.test("'hello'")).toBe(true);
	});
	it("matches integer", () => {
		expect(BARE_LITERAL_VALUE_RE.test("42")).toBe(true);
	});
	it("matches negative integer", () => {
		expect(BARE_LITERAL_VALUE_RE.test("-42")).toBe(true);
	});
	it("matches positive integer", () => {
		expect(BARE_LITERAL_VALUE_RE.test("+42")).toBe(true);
	});
	it("matches float", () => {
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
	it("matches with trailing comma", () => {
		expect(BARE_LITERAL_VALUE_RE.test("42,")).toBe(true);
	});
	it("matches with surrounding whitespace", () => {
		expect(BARE_LITERAL_VALUE_RE.test("  42  ")).toBe(true);
	});
	it("does not match object", () => {
		expect(BARE_LITERAL_VALUE_RE.test("{ key: 1 }")).toBe(false);
	});
	it("does not match array", () => {
		expect(BARE_LITERAL_VALUE_RE.test("[1, 2]")).toBe(false);
	});
	it("does not match unquoted string", () => {
		expect(BARE_LITERAL_VALUE_RE.test("hello")).toBe(false);
	});
	it("does not match empty string", () => {
		expect(BARE_LITERAL_VALUE_RE.test("")).toBe(false);
	});
	it("does not match identifier", () => {
		expect(BARE_LITERAL_VALUE_RE.test("undefined")).toBe(false);
	});
});

describe("detectApplyPatchContamination", () => {
	it("detects Update File sentinel", () => {
		const result = detectApplyPatchContamination("*** Update File: foo.ts", false);
		expect(result).toContain("apply_patch sentinel");
		expect(result).toContain("Update File");
	});
	it("detects Add File sentinel", () => {
		const result = detectApplyPatchContamination("*** Add File: foo.ts", false);
		expect(result).toContain("Add File");
	});
	it("detects Delete File sentinel", () => {
		const result = detectApplyPatchContamination("*** Delete File: foo.ts", false);
		expect(result).toContain("Delete File");
	});
	it("detects Move to sentinel", () => {
		const result = detectApplyPatchContamination("*** Move to: foo.ts", false);
		expect(result).toContain("Move to");
	});
	it("detects unified-diff hunk header", () => {
		const result = detectApplyPatchContamination("@@ -1,5 +1,5 @@", false);
		expect(result).toContain("unified-diff");
	});
	it("detects bare @@ hunk header", () => {
		const result = detectApplyPatchContamination("@@ some content", false);
		expect(result).toContain("@@");
	});
	it("detects DEL with colon", () => {
		const result = detectApplyPatchContamination("DEL 5.=10:", false);
		expect(result).toContain("no colon");
	});
	it("detects bare number", () => {
		const result = detectApplyPatchContamination("42", false);
		expect(result).toContain("hunk headers need a verb");
	});
	it("detects bare range with separator", () => {
		const result = detectApplyPatchContamination("5.=10:", false);
		expect(result).toContain("bare range");
	});
	it("detects bare range without colon", () => {
		const result = detectApplyPatchContamination("5.=10", false);
		expect(result).toContain("bare range");
	});
	it("returns null for empty string", () => {
		expect(detectApplyPatchContamination("", false)).toBeNull();
	});
	it("returns null for whitespace-only string", () => {
		expect(detectApplyPatchContamination("   ", false)).toBeNull();
	});
	it("returns null for valid SWAP header", () => {
		expect(detectApplyPatchContamination("SWAP 5.=10:", false)).toBeNull();
	});
	it("returns null for valid DEL header", () => {
		expect(detectApplyPatchContamination("DEL 5", false)).toBeNull();
	});
	it("returns null for valid INS header", () => {
		expect(detectApplyPatchContamination("INS.PRE 5:", false)).toBeNull();
	});
	it("returns null for regular text", () => {
		expect(detectApplyPatchContamination("hello world", false)).toBeNull();
	});
	it("truncates long sentinel preview", () => {
		const longSentinel = `*** Update File: ${"x".repeat(100)}`;
		const result = detectApplyPatchContamination(longSentinel, false);
		expect(result).toContain("…");
	});
	it("truncates long @@ hunk preview", () => {
		const longHunk = `@@ ${"x".repeat(100)}`;
		const result = detectApplyPatchContamination(longHunk, false);
		expect(result).toContain("…");
	});
	it("detects bare range with .. separator", () => {
		const result = detectApplyPatchContamination("5..10", false);
		expect(result).toContain("bare range");
	});
	it("detects bare range with - separator", () => {
		const result = detectApplyPatchContamination("5-10", false);
		expect(result).toContain("bare range");
	});
	it("detects bare range with … separator", () => {
		const result = detectApplyPatchContamination("5…10", false);
		expect(result).toContain("bare range");
	});
});
