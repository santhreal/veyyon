import { describe, expect, it } from "bun:test";
import { parseLineRangeChunk, parseLineRanges } from "@veyyon/coding-agent/tools/path-utils";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";

/**
 * Regression lock for the spaced multi-range selector bug. A selector like
 * `1-3, 5-7` (a space after the comma) used to make `parseLineRanges` return
 * `null` because the `" 5-7"` chunk failed the anchored range regex. The read
 * tool treats a null parse as "no selector" and reads the WHOLE FILE, so a
 * request for two small ranges silently widened to the entire file (a silent
 * fallback, Law 10). `parseLineRangeChunk` now trims surrounding whitespace so
 * the list parses; internal whitespace and bad bounds still reject.
 */
describe("parseLineRangeChunk whitespace tolerance", () => {
	it("trims leading and trailing whitespace around a range", () => {
		expect(parseLineRangeChunk("  5-7  ")).toEqual({ startLine: 5, endLine: 7 });
		expect(parseLineRangeChunk("\t42\t")).toEqual({ startLine: 42, endLine: undefined });
		expect(parseLineRangeChunk(" 10+3 ")).toEqual({ startLine: 10, endLine: 12 });
	});

	it("still rejects internal whitespace inside a range token", () => {
		// Only surrounding whitespace is forgiven; `1 - 3` is genuinely malformed.
		expect(parseLineRangeChunk("1 - 3")).toBeNull();
		expect(parseLineRangeChunk("5 -")).toBeNull();
	});

	it("still validates bounds after trimming", () => {
		expect(() => parseLineRangeChunk(" 5-3 ")).toThrow(ToolError);
		expect(() => parseLineRangeChunk(" 0 ")).toThrow(ToolError);
	});
});

describe("parseLineRanges with spaces after commas", () => {
	it("parses a spaced two-range list identically to the unspaced form", () => {
		const spaced = parseLineRanges("1-3, 5-7");
		expect(spaced).toEqual([
			{ startLine: 1, endLine: 3 },
			{ startLine: 5, endLine: 7 },
		]);
		expect(spaced).toEqual(parseLineRanges("1-3,5-7"));
	});

	it("parses a spaced list with varied padding and `..` aliases", () => {
		expect(parseLineRanges("3..5 ,  20-22")).toEqual([
			{ startLine: 3, endLine: 5 },
			{ startLine: 20, endLine: 22 },
		]);
	});

	it("merges spaced adjacent ranges just like unspaced ones", () => {
		// 5-7 and 8-10 are adjacent (8 == 7 + 1) and must merge into 5-10.
		expect(parseLineRanges("5-7,  8-10")).toEqual([{ startLine: 5, endLine: 10 }]);
	});
});
