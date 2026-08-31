import { describe, expect, it } from "bun:test";
import { escapeLike, SQLITE_NOW_EPOCH, sqlPlaceholders } from "@veyyon/utils/sqlite";
import { truncateForLog } from "../src/util/log-format";
import { SQLITE_IN_CLAUSE_BATCH } from "../src/util/sqlite";

describe("truncateForLog", () => {
	it("returns value when within limit", () => {
		expect(truncateForLog("hello", 10)).toBe("hello");
	});
	it("returns value when exactly at limit", () => {
		expect(truncateForLog("hello", 5)).toBe("hello");
	});
	it("truncates when over limit", () => {
		expect(truncateForLog("hello world", 5)).toBe("hello...[truncated]");
	});
	it("handles empty string", () => {
		expect(truncateForLog("", 10)).toBe("");
	});
	it("handles zero limit", () => {
		expect(truncateForLog("hello", 0)).toBe("...[truncated]");
	});
});

describe("SQLITE_IN_CLAUSE_BATCH", () => {
	it("is 500", () => {
		expect(SQLITE_IN_CLAUSE_BATCH).toBe(500);
	});
});

describe("SQLITE_NOW_EPOCH", () => {
	it("is the strftime cast expression", () => {
		expect(SQLITE_NOW_EPOCH).toBe("CAST(strftime('%s','now') AS INTEGER)");
	});
});

describe("sqlPlaceholders", () => {
	it("returns empty string for 0", () => {
		expect(sqlPlaceholders(0)).toBe("");
	});
	it("returns single ? for 1", () => {
		expect(sqlPlaceholders(1)).toBe("?");
	});
	it("returns comma-separated ? for 3", () => {
		expect(sqlPlaceholders(3)).toBe("?, ?, ?");
	});
	it("throws for negative count", () => {
		expect(() => sqlPlaceholders(-1)).toThrow(RangeError);
	});
	it("throws for non-integer", () => {
		expect(() => sqlPlaceholders(1.5)).toThrow(RangeError);
	});
});

describe("escapeLike", () => {
	it("escapes backslash", () => {
		expect(escapeLike("a\\b")).toBe("a\\\\b");
	});
	it("escapes percent", () => {
		expect(escapeLike("a%b")).toBe("a\\%b");
	});
	it("escapes underscore", () => {
		expect(escapeLike("a_b")).toBe("a\\_b");
	});
	it("does not escape other characters", () => {
		expect(escapeLike("hello world")).toBe("hello world");
	});
	it("handles empty string", () => {
		expect(escapeLike("")).toBe("");
	});
	it("escapes all special chars in one string", () => {
		expect(escapeLike("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
	});
});
