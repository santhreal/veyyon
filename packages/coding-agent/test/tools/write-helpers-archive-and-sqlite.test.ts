/**
 * WHY: `normalizeArchiveWriteSubPath` and `parseSqliteWriteTarget` are pure
 * validation functions that guard the write tool's archive and SQLite paths.
 * A bug in either silently writes to the wrong location or throws a confusing
 * error. Neither had direct tests.
 *
 * `normalizeArchiveWriteSubPath` normalizes Windows backslashes, rejects
 * directory targets (trailing slash), rejects `..` traversal, and strips
 * empty/`.` segments. `parseSqliteWriteTarget` rejects query parameters,
 * strips leading colons, splits `table:key`, and rejects empty table/key.
 *
 * This suite covers every branch: valid inputs, each error path, edge cases
 * at segment boundaries, and the table:key split logic.
 */
import { describe, expect, it } from "bun:test";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { normalizeArchiveWriteSubPath, parseSqliteWriteTarget } from "@veyyon/coding-agent/tools/write-helpers";

// ─── normalizeArchiveWriteSubPath ─────────────────────────────────

describe("normalizeArchiveWriteSubPath", () => {
	describe("valid inputs", () => {
		it("passes through a simple file path", () => {
			expect(normalizeArchiveWriteSubPath("src/file.ts")).toBe("src/file.ts");
		});

		it("normalizes Windows backslashes to forward slashes", () => {
			expect(normalizeArchiveWriteSubPath("src\\file.ts")).toBe("src/file.ts");
		});

		it("normalizes mixed separators", () => {
			expect(normalizeArchiveWriteSubPath("src\\sub/file.ts")).toBe("src/sub/file.ts");
		});

		it("strips empty segments from double slashes", () => {
			expect(normalizeArchiveWriteSubPath("src//file.ts")).toBe("src/file.ts");
		});

		it("strips dot segments", () => {
			expect(normalizeArchiveWriteSubPath("src/./file.ts")).toBe("src/file.ts");
		});

		it("strips leading dot segments", () => {
			expect(normalizeArchiveWriteSubPath("./src/file.ts")).toBe("src/file.ts");
		});

		it("strips multiple dot and empty segments", () => {
			expect(normalizeArchiveWriteSubPath("./src/././file.ts")).toBe("src/file.ts");
		});

		it("handles a flat filename", () => {
			expect(normalizeArchiveWriteSubPath("file.ts")).toBe("file.ts");
		});

		it("handles deeply nested paths", () => {
			expect(normalizeArchiveWriteSubPath("a/b/c/d/e/f.ts")).toBe("a/b/c/d/e/f.ts");
		});
	});

	describe("error paths", () => {
		it("throws on empty string", () => {
			expect(() => normalizeArchiveWriteSubPath("")).toThrow(ToolError);
			expect(() => normalizeArchiveWriteSubPath("")).toThrow("must target a file inside the archive");
		});

		it("throws on trailing slash (directory target)", () => {
			expect(() => normalizeArchiveWriteSubPath("src/")).toThrow(ToolError);
			expect(() => normalizeArchiveWriteSubPath("src/")).toThrow("not a directory");
		});

		it("throws on trailing backslash (directory target)", () => {
			expect(() => normalizeArchiveWriteSubPath("src\\")).toThrow(ToolError);
		});

		it("throws on .. traversal", () => {
			expect(() => normalizeArchiveWriteSubPath("../file.ts")).toThrow(ToolError);
			expect(() => normalizeArchiveWriteSubPath("../file.ts")).toThrow("cannot contain '..'");
		});

		it("throws on .. in the middle", () => {
			expect(() => normalizeArchiveWriteSubPath("src/../file.ts")).toThrow(ToolError);
		});

		it("throws on .. with backslash", () => {
			expect(() => normalizeArchiveWriteSubPath("..\\file.ts")).toThrow(ToolError);
		});

		it("throws when only empty/dot segments remain", () => {
			expect(() => normalizeArchiveWriteSubPath("./.")).toThrow(ToolError);
			expect(() => normalizeArchiveWriteSubPath(".")).toThrow(ToolError);
		});

		it("throws when path normalizes to empty", () => {
			expect(() => normalizeArchiveWriteSubPath("//")).toThrow(ToolError);
		});
	});
});

// ─── parseSqliteWriteTarget ───────────────────────────────────────

describe("parseSqliteWriteTarget", () => {
	describe("valid inputs", () => {
		it("parses a bare table name", () => {
			expect(parseSqliteWriteTarget("users", "")).toEqual({ table: "users" });
		});

		it("parses table:key", () => {
			expect(parseSqliteWriteTarget("users:42", "")).toEqual({ table: "users", key: "42" });
		});

		it("parses table with leading colons stripped", () => {
			expect(parseSqliteWriteTarget(":::users", "")).toEqual({ table: "users" });
		});

		it("parses table:key with leading colons stripped", () => {
			expect(parseSqliteWriteTarget(":users:42", "")).toEqual({ table: "users", key: "42" });
		});

		it("trims whitespace around the path", () => {
			expect(parseSqliteWriteTarget("  users  ", "")).toEqual({ table: "users" });
		});
		it("does not throw on whitespace-only query string (no non-whitespace content)", () => {
			expect(parseSqliteWriteTarget("users", "  ")).toEqual({ table: "users" });
			expect(parseSqliteWriteTarget("my table", "")).toEqual({ table: "my table" });
		});

		it("parses a key containing colons", () => {
			expect(parseSqliteWriteTarget("users:a:b:c", "")).toEqual({ table: "users", key: "a:b:c" });
		});
	});

	describe("error paths", () => {
		it("throws on non-empty query string", () => {
			expect(() => parseSqliteWriteTarget("users", "limit=10")).toThrow(ToolError);
			expect(() => parseSqliteWriteTarget("users", "limit=10")).toThrow("do not support query parameters");
		});

		it("throws on empty path", () => {
			expect(() => parseSqliteWriteTarget("", "")).toThrow(ToolError);
			expect(() => parseSqliteWriteTarget("", "")).toThrow("must target a table");
		});

		it("throws on whitespace-only path", () => {
			expect(() => parseSqliteWriteTarget("   ", "")).toThrow(ToolError);
		});

		it("throws on colons-only path", () => {
			expect(() => parseSqliteWriteTarget(":::", "")).toThrow(ToolError);
		});

		it("strips leading colons from :42 making it a valid table name", () => {
			expect(parseSqliteWriteTarget(":42", "")).toEqual({ table: "42" });
		});

		it("throws when key is empty", () => {
			expect(() => parseSqliteWriteTarget("users:", "")).toThrow(ToolError);
			expect(() => parseSqliteWriteTarget("users:", "")).toThrow("non-empty row key");
		});
	});
});
