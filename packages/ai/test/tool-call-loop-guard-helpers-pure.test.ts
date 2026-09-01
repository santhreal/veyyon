import { describe, expect, it } from "bun:test";
import {
	ARGUMENT_SUMMARY_LIMIT,
	canonicalizeToolCallValue,
	extractSnapshotTag,
	type FileReadHistory,
	isTargetSubsumed,
	LEGACY_INTENT_FIELD,
	MUTATING_TOOLS,
	parseRangeSelector,
	parseReadTarget,
	parseReadTargets,
	RANGE_CHUNK_RE,
	RESULT_SUMMARY_LIMIT,
	summarizeText,
	URI_SCHEME_PREFIX_RE,
	WINDOWS_DRIVE_RE,
} from "../src/utils/tool-call-loop-guard-helpers";

describe("constants", () => {
	it("LEGACY_INTENT_FIELD is __intent", () => {
		expect(LEGACY_INTENT_FIELD).toBe("__intent");
	});
	it("RESULT_SUMMARY_LIMIT is 200", () => {
		expect(RESULT_SUMMARY_LIMIT).toBe(200);
	});
	it("ARGUMENT_SUMMARY_LIMIT is 400", () => {
		expect(ARGUMENT_SUMMARY_LIMIT).toBe(400);
	});
	it("MUTATING_TOOLS contains edit, write, ast_edit, patch", () => {
		expect(MUTATING_TOOLS.edit).toBe(true);
		expect(MUTATING_TOOLS.write).toBe(true);
		expect(MUTATING_TOOLS.ast_edit).toBe(true);
		expect(MUTATING_TOOLS.patch).toBe(true);
	});
	it("MUTATING_TOOLS does not contain read", () => {
		expect(MUTATING_TOOLS.read).toBeUndefined();
	});
});

describe("RANGE_CHUNK_RE", () => {
	it("matches single line number", () => {
		expect(RANGE_CHUNK_RE.test("42")).toBe(true);
	});
	it("matches L prefix", () => {
		expect(RANGE_CHUNK_RE.test("L42")).toBe(true);
	});
	it("matches range with ..", () => {
		expect(RANGE_CHUNK_RE.test("1..10")).toBe(true);
	});
	it("matches range with -", () => {
		expect(RANGE_CHUNK_RE.test("1-10")).toBe(true);
	});
	it("matches range with +", () => {
		expect(RANGE_CHUNK_RE.test("1+5")).toBe(true);
	});
	it("matches case-insensitive L prefix", () => {
		expect(RANGE_CHUNK_RE.test("l42")).toBe(true);
	});
});

describe("WINDOWS_DRIVE_RE", () => {
	it("matches C:\\", () => {
		expect(WINDOWS_DRIVE_RE.test("C:\\path")).toBe(true);
	});
	it("matches D:/", () => {
		expect(WINDOWS_DRIVE_RE.test("D:/path")).toBe(true);
	});
	it("does not match unix path", () => {
		expect(WINDOWS_DRIVE_RE.test("/home/user")).toBe(false);
	});
});

describe("URI_SCHEME_PREFIX_RE", () => {
	it("matches https://", () => {
		expect(URI_SCHEME_PREFIX_RE.test("https://example.com")).toBe(true);
	});
	it("matches http://", () => {
		expect(URI_SCHEME_PREFIX_RE.test("http://example.com")).toBe(true);
	});
	it("matches ssh://", () => {
		expect(URI_SCHEME_PREFIX_RE.test("ssh://host/path")).toBe(true);
	});
	it("does not match bare path", () => {
		expect(URI_SCHEME_PREFIX_RE.test("/path/to/file")).toBe(false);
	});
	it("does not match windows drive", () => {
		expect(URI_SCHEME_PREFIX_RE.test("C:\\path")).toBe(false);
	});
});

describe("parseRangeSelector", () => {
	it("parses single line", () => {
		expect(parseRangeSelector("42")).toEqual([{ start: 42, end: 42 }]);
	});
	it("parses range with ..", () => {
		expect(parseRangeSelector("1..10")).toEqual([{ start: 1, end: 10 }]);
	});
	it("parses range with -", () => {
		expect(parseRangeSelector("1-10")).toEqual([{ start: 1, end: 10 }]);
	});
	it("parses range with +", () => {
		expect(parseRangeSelector("5+3")).toEqual([{ start: 5, end: 7 }]);
	});
	it("parses + without rhs defaults to start", () => {
		expect(parseRangeSelector("5+")).toEqual([{ start: 5, end: 5 }]);
	});
	it("parses - without rhs as infinity", () => {
		expect(parseRangeSelector("5-")).toEqual([{ start: 5, end: Number.POSITIVE_INFINITY }]);
	});
	it("parses L prefix", () => {
		expect(parseRangeSelector("L42")).toEqual([{ start: 42, end: 42 }]);
	});
	it("parses multiple ranges", () => {
		expect(parseRangeSelector("1..5,10..20")).toEqual([
			{ start: 1, end: 5 },
			{ start: 10, end: 20 },
		]);
	});
	it("returns null for invalid chunk", () => {
		expect(parseRangeSelector("abc")).toBeNull();
	});
	it("returns null for line 0", () => {
		expect(parseRangeSelector("0")).toBeNull();
	});
	it("returns null if any chunk is invalid", () => {
		expect(parseRangeSelector("1..5,abc")).toBeNull();
	});
});

describe("parseReadTarget", () => {
	it("returns empty basePath for empty string", () => {
		expect(parseReadTarget("")).toEqual({ basePath: "", isRange: false });
	});
	it("returns empty basePath for whitespace", () => {
		expect(parseReadTarget("  ")).toEqual({ basePath: "", isRange: false });
	});
	it("parses plain path", () => {
		expect(parseReadTarget("/path/to/file.ts")).toEqual({ basePath: "/path/to/file.ts", isRange: false });
	});
	it("parses path with line range", () => {
		const result = parseReadTarget("src/file.ts:1..10");
		expect(result.basePath).toBe("src/file.ts");
		expect(result.isRange).toBe(true);
		expect(result.ranges).toEqual([{ start: 1, end: 10 }]);
	});
	it("parses path with single line", () => {
		const result = parseReadTarget("src/file.ts:42");
		expect(result.basePath).toBe("src/file.ts");
		expect(result.isRange).toBe(true);
		expect(result.ranges).toEqual([{ start: 42, end: 42 }]);
	});
	it("parses path with raw selector", () => {
		const result = parseReadTarget("src/file.ts:raw");
		expect(result.basePath).toBe("src/file.ts");
		expect(result.isRange).toBe(false);
	});
	it("parses path with conflicts selector", () => {
		const result = parseReadTarget("src/file.ts:conflicts");
		expect(result.basePath).toBe("src/file.ts");
		expect(result.isRange).toBe(false);
	});
	it("parses windows drive path without range", () => {
		const result = parseReadTarget("C:\\path\\to\\file.ts");
		expect(result.basePath).toBe("C:\\path\\to\\file.ts");
		expect(result.isRange).toBe(false);
	});
	it("parses URI scheme path without range", () => {
		const result = parseReadTarget("https://example.com/path");
		expect(result.basePath).toBe("https://example.com/path");
		expect(result.isRange).toBe(false);
	});
	it("parses ssh URI with range after", () => {
		const result = parseReadTarget("ssh://host/path:1..10");
		expect(result.isRange).toBe(true);
		expect(result.ranges).toEqual([{ start: 1, end: 10 }]);
	});
	it("handles trailing colon with empty selector", () => {
		const result = parseReadTarget("src/file.ts:");
		expect(result.basePath).toBe("src/file.ts");
		expect(result.isRange).toBe(false);
	});
	it("handles path with colon but no range/raw/conflicts", () => {
		const result = parseReadTarget("src/file.ts:abc");
		expect(result.basePath).toBe("src/file.ts:abc");
		expect(result.isRange).toBe(false);
	});
});

describe("parseReadTargets", () => {
	it("returns empty array for non-string", () => {
		expect(parseReadTargets(42)).toEqual([]);
		expect(parseReadTargets(null)).toEqual([]);
		expect(parseReadTargets(undefined)).toEqual([]);
	});
	it("returns empty array for empty string", () => {
		expect(parseReadTargets("")).toEqual([]);
	});
	it("parses single target", () => {
		const result = parseReadTargets("src/file.ts");
		expect(result).toHaveLength(1);
		expect(result[0].basePath).toBe("src/file.ts");
	});
	it("parses multiple targets separated by ;", () => {
		const result = parseReadTargets("src/a.ts;src/b.ts");
		expect(result).toHaveLength(2);
		expect(result[0].basePath).toBe("src/a.ts");
		expect(result[1].basePath).toBe("src/b.ts");
	});
	it("filters out empty targets", () => {
		const result = parseReadTargets("src/a.ts;;src/b.ts;");
		expect(result).toHaveLength(2);
	});
});

describe("isTargetSubsumed", () => {
	it("returns false for no history", () => {
		expect(isTargetSubsumed({ basePath: "file.ts", isRange: false }, undefined)).toBe(false);
	});
	it("returns true for non-range target when hasSelectorFree", () => {
		const history: FileReadHistory = { hasSelectorFree: true, ranges: [] };
		expect(isTargetSubsumed({ basePath: "file.ts", isRange: false }, history)).toBe(true);
	});
	it("returns false for non-range target when not hasSelectorFree", () => {
		const history: FileReadHistory = { hasSelectorFree: false, ranges: [] };
		expect(isTargetSubsumed({ basePath: "file.ts", isRange: false }, history)).toBe(false);
	});
	it("returns true when range is fully contained in history range", () => {
		const history: FileReadHistory = { hasSelectorFree: false, ranges: [{ start: 1, end: 100 }] };
		expect(isTargetSubsumed({ basePath: "file.ts", isRange: true, ranges: [{ start: 10, end: 20 }] }, history)).toBe(
			true,
		);
	});
	it("returns false when range is not fully contained", () => {
		const history: FileReadHistory = { hasSelectorFree: false, ranges: [{ start: 1, end: 50 }] };
		expect(isTargetSubsumed({ basePath: "file.ts", isRange: true, ranges: [{ start: 10, end: 100 }] }, history)).toBe(
			false,
		);
	});
	it("returns true when all ranges are subsumed", () => {
		const history: FileReadHistory = {
			hasSelectorFree: false,
			ranges: [
				{ start: 1, end: 50 },
				{ start: 60, end: 100 },
			],
		};
		expect(
			isTargetSubsumed(
				{
					basePath: "file.ts",
					isRange: true,
					ranges: [
						{ start: 10, end: 20 },
						{ start: 70, end: 80 },
					],
				},
				history,
			),
		).toBe(true);
	});
	it("returns false when not all ranges are subsumed", () => {
		const history: FileReadHistory = { hasSelectorFree: false, ranges: [{ start: 1, end: 50 }] };
		expect(
			isTargetSubsumed(
				{
					basePath: "file.ts",
					isRange: true,
					ranges: [
						{ start: 10, end: 20 },
						{ start: 60, end: 70 },
					],
				},
				history,
			),
		).toBe(false);
	});
});

describe("extractSnapshotTag", () => {
	it("extracts 4-hex tag from file header", () => {
		expect(extractSnapshotTag("[file.ts#A1B2]")).toBe("A1B2");
	});
	it("extracts lowercase hex", () => {
		expect(extractSnapshotTag("[file.ts#a1b2]")).toBe("a1b2");
	});
	it("returns undefined for no tag", () => {
		expect(extractSnapshotTag("no tag here")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(extractSnapshotTag("")).toBeUndefined();
	});
	it("returns undefined for non-hex tag", () => {
		expect(extractSnapshotTag("[file.ts#XYZ1]")).toBeUndefined();
	});
	it("returns undefined for too-short tag", () => {
		expect(extractSnapshotTag("[file.ts#A1B]")).toBeUndefined();
	});
	it("returns undefined for too-long tag", () => {
		expect(extractSnapshotTag("[file.ts#A1B2C3]")).toBeUndefined();
	});
});

describe("canonicalizeToolCallValue", () => {
	it("returns primitives as-is", () => {
		expect(canonicalizeToolCallValue(42)).toBe(42);
		expect(canonicalizeToolCallValue("hello")).toBe("hello");
		expect(canonicalizeToolCallValue(true)).toBe(true);
		expect(canonicalizeToolCallValue(null)).toBe(null);
	});
	it("returns undefined as-is", () => {
		expect(canonicalizeToolCallValue(undefined)).toBe(undefined);
	});
	it("sorts object keys", () => {
		const result = canonicalizeToolCallValue({ b: 2, a: 1 });
		expect(Object.keys(result as Record<string, unknown>)).toEqual(["a", "b"]);
	});
	it("removes __intent field", () => {
		const result = canonicalizeToolCallValue({ __intent: "test", value: 42 }) as Record<string, unknown>;
		expect(result.__intent).toBeUndefined();
		expect(result.value).toBe(42);
	});
	it("removes intent field (i)", () => {
		const result = canonicalizeToolCallValue({ i: "test", value: 42 }) as Record<string, unknown>;
		expect(result.i).toBeUndefined();
		expect(result.value).toBe(42);
	});
	it("recursively canonicalizes nested objects", () => {
		const result = canonicalizeToolCallValue({ outer: { z: 1, a: 2 } }) as Record<string, unknown>;
		const inner = result.outer as Record<string, unknown>;
		expect(Object.keys(inner)).toEqual(["a", "z"]);
	});
	it("recursively canonicalizes arrays", () => {
		const result = canonicalizeToolCallValue([{ b: 2, a: 1 }]) as unknown[];
		const inner = result[0] as Record<string, unknown>;
		expect(Object.keys(inner)).toEqual(["a", "b"]);
	});
	it("preserves array order", () => {
		const result = canonicalizeToolCallValue([3, 1, 2]) as unknown[];
		expect(result).toEqual([3, 1, 2]);
	});
});

describe("summarizeText", () => {
	it("returns short text as-is (collapsed)", () => {
		expect(summarizeText("hello world", 100)).toBe("hello world");
	});
	it("collapses whitespace", () => {
		expect(summarizeText("hello    world", 100)).toBe("hello world");
	});
	it("truncates with ellipsis when over limit", () => {
		const result = summarizeText("abcdefghij", 5);
		expect(result).toBe("abcde…");
	});
	it("returns exact length text without truncation", () => {
		expect(summarizeText("abcde", 5)).toBe("abcde");
	});
	it("handles empty string", () => {
		expect(summarizeText("", 100)).toBe("");
	});
	it("collapses newlines", () => {
		expect(summarizeText("hello\n\nworld", 100)).toBe("hello world");
	});
});
