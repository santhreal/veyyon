import { describe, expect, it } from "bun:test";
import { countLines, parseReadArgs, parseReadDetails, parseWriteArgs, parseWriteDetails } from "../src/fs-tool-args";

describe("a read or write call parses to a path and a range", () => {
	describe("countLines", () => {
		it("counts lines without allocating arrays", () => {
			expect(countLines(null)).toBe(0);
			expect(countLines(undefined)).toBe(0);
			expect(countLines("")).toBe(0);
			expect(countLines("one line")).toBe(1);
			expect(countLines("line1\nline2")).toBe(2);
			expect(countLines("line1\nline2\nline3\n")).toBe(4);
			expect(countLines("line1\r\nline2\r\n")).toBe(3);
		});
	});

	describe("parseReadArgs", () => {
		it("parses empty or non-record input without throwing", () => {
			const empty = { rawPath: "", path: "", sel: null, depth: null, limit: null };
			expect(parseReadArgs(null)).toEqual(empty);
			expect(parseReadArgs(undefined)).toEqual(empty);
			expect(parseReadArgs("not-a-record")).toEqual(empty);
			expect(parseReadArgs(123)).toEqual(empty);
		});

		it("prefers path over file_path when both are present", () => {
			expect(parseReadArgs({ path: "primary.ts", file_path: "fallback.ts" })).toEqual({
				rawPath: "primary.ts",
				path: "primary.ts",
				sel: null,
				depth: null,
				limit: null,
			});
			expect(parseReadArgs({ file_path: "fallback.ts" })).toEqual({
				rawPath: "fallback.ts",
				path: "fallback.ts",
				sel: null,
				depth: null,
				limit: null,
			});
		});

		it("extracts inline selector and compound selectors", () => {
			const parsed = parseReadArgs({ path: "src/foo.ts:10-50:raw" });
			expect(parsed.rawPath).toBe("src/foo.ts:10-50:raw");
			expect(parsed.path).toBe("src/foo.ts");
			expect(parsed.sel).toBe("10-50:raw");
		});

		it("parses depth and limit as directory arguments and derives no line range from them", () => {
			// `limit` caps directory entries and `depth` bounds recursion; the schema has no `offset`
			// and no line window, so `{ path: ".", limit: 3 }` is a 3-entry listing, not lines 1-3.
			expect(parseReadArgs({ path: ".", depth: 2, limit: 5 })).toEqual({
				rawPath: ".",
				path: ".",
				sel: null,
				depth: 2,
				limit: 5,
			});
			expect(parseReadArgs({ path: ".", limit: 3 })).toEqual({
				rawPath: ".",
				path: ".",
				sel: null,
				depth: null,
				limit: 3,
			});
			expect(parseReadArgs({ path: "a.ts:10-29", limit: 3 })).toEqual({
				rawPath: "a.ts:10-29",
				path: "a.ts",
				sel: "10-29",
				depth: null,
				limit: 3,
			});
		});

		it("rejects non-number depth and limit", () => {
			const parsed = parseReadArgs({ path: ".", depth: "2", limit: "invalid" });
			expect(parsed.depth).toBeNull();
			expect(parsed.limit).toBeNull();
		});
	});

	describe("parseReadDetails", () => {
		it("parses non-record input gracefully", () => {
			expect(parseReadDetails(null)).toEqual({
				resolvedPath: null,
				suffixTo: null,
				suffixFrom: null,
				elidedSpans: null,
				conflictCount: null,
				truncated: false,
				totalLines: null,
			});
			expect(parseReadDetails("not-an-object")).toEqual({
				resolvedPath: null,
				suffixTo: null,
				suffixFrom: null,
				elidedSpans: null,
				conflictCount: null,
				truncated: false,
				totalLines: null,
			});
		});

		it("parses resolvedPath, suffixResolution, summary, and truncation", () => {
			const details = {
				resolvedPath: "/abs/path/file.ts",
				suffixResolution: { from: "file.js", to: "/abs/path/file.ts" },
				summary: { elidedSpans: 4 },
				conflictCount: 2,
				truncation: { totalLines: 1000 },
			};
			expect(parseReadDetails(details)).toEqual({
				resolvedPath: "/abs/path/file.ts",
				suffixTo: "/abs/path/file.ts",
				suffixFrom: "file.js",
				elidedSpans: 4,
				conflictCount: 2,
				truncated: true,
				totalLines: 1000,
			});
		});
	});

	describe("parseWriteArgs", () => {
		it("prefers path over file_path when both are present", () => {
			expect(parseWriteArgs({ path: "a.ts", file_path: "b.ts", content: "hi" })).toEqual({
				path: "a.ts",
				content: "hi",
				isValidContent: true,
			});
			expect(parseWriteArgs({ file_path: "b.ts", content: "hi" })).toEqual({
				path: "b.ts",
				content: "hi",
				isValidContent: true,
			});
		});

		it("parses valid string content without coercion", () => {
			expect(parseWriteArgs({ path: "src/a.ts", content: "data" })).toEqual({
				path: "src/a.ts",
				content: "data",
				isValidContent: true,
			});
			expect(parseWriteArgs({ path: "src/b.ts", content: "" })).toEqual({
				path: "src/b.ts",
				content: "",
				isValidContent: true,
			});
		});

		it("distinguishes non-string content as invalid without coercion", () => {
			expect(parseWriteArgs({ path: "src/a.ts", content: 12345 })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: { obj: true } })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: [1, 2, 3] })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: true })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts", content: null })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs({ path: "src/a.ts" })).toEqual({
				path: "src/a.ts",
				content: null,
				isValidContent: false,
			});
			expect(parseWriteArgs("invalid")).toEqual({
				path: null,
				content: null,
				isValidContent: false,
			});
		});
	});

	describe("parseWriteDetails", () => {
		it("parses non-record input gracefully", () => {
			expect(parseWriteDetails(null)).toEqual({
				madeExecutable: false,
				diagnostics: null,
			});
			expect(parseWriteDetails(123)).toEqual({
				madeExecutable: false,
				diagnostics: null,
			});
		});

		it("parses madeExecutable and diagnostics structure", () => {
			const details = {
				madeExecutable: true,
				diagnostics: {
					server: "rust-analyzer",
					messages: ["warning: unused variable", "error: type mismatch"],
					summary: "1 error, 1 warning",
					errored: true,
				},
			};
			expect(parseWriteDetails(details)).toEqual({
				madeExecutable: true,
				diagnostics: {
					server: "rust-analyzer",
					messages: ["warning: unused variable", "error: type mismatch"],
					summary: "1 error, 1 warning",
					errored: true,
				},
			});
		});
	});
});
